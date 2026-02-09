/**
 * Stripe Webhook → スプレッドシート & 有料判定API
 * Render にデプロイする。
 * - POST /webhook: Stripe の Webhook 受信 → 「有料ユーザー」シートに email / status / subscription_id を追加・更新
 * - GET /check?email=xxx: 有料判定（status が active のときのみ { paid: true }、それ以外は { paid: false, status? }）
 *
 * シート「有料ユーザー」: A列=email（Googleアカウント）, B列=status（active/past_due/canceled）, C列=subscription_id（任意）
 *
 * 環境変数:
 *   STRIPE_WEBHOOK_SECRET   - Stripe ダッシュボードの Webhook 署名シークレット
 *   SPREADSHEET_ID          - 有料ユーザー一覧のスプレッドシート ID
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON - サービスアカウント鍵 JSON の文字列（1行にしたもの）
 *   GOOGLE_ACCOUNT_FIELD_KEY - （任意）Stripe Checkout の「Googleアカウント」カスタムフィールドの key。未設定時は最初の text カスタムフィールドを使用
 */

const express = require('express');
const Stripe = require('stripe');

const SHEET_NAME = '有料ユーザー';
const STATUS_ACTIVE = 'active';

const app = express();
const port = process.env.PORT || 3000;

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const spreadsheetId = process.env.SPREADSHEET_ID;
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const googleAccountFieldKey = process.env.GOOGLE_ACCOUNT_FIELD_KEY || '';

// Webhook ルートだけ生 body で受け取る（署名検証のため）
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// CORS ヘッダーを設定（/check エンドポイント用）
app.use((req, res, next) => {
  // /check と /health エンドポイントにCORSヘッダーを追加
  if (req.path === '/check' || req.path === '/health') {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'stripe-to-sheet' });
});

/**
 * 有料判定: GET /check?email=xxx → { paid: true/false, status?: string }
 * status が 'active' のときのみ paid: true。past_due / canceled / 未登録は paid: false（必要なら status を返す）
 * Google OAuth で取得したメールアドレス（Googleアカウント）でスプレッドシートのA列と照合
 */
app.get('/check', async (req, res) => {
  const email = (req.query.email && String(req.query.email).trim()) || '';
  const result = { paid: false };
  if (!email) {
    return res.json(result);
  }
  try {
    const { paid, status } = await checkPaidUserEmail(email);
    result.paid = paid;
    if (status) result.status = status;
  } catch (err) {
    console.error('check failed:', err.message);
  }
  res.json(result);
});

app.post('/webhook', async (req, res) => {
  if (!req.body || req.body.length === 0) {
    console.error('Webhook: empty body');
    return res.status(400).send('Empty body');
  }

  const sig = req.headers['stripe-signature'];
  if (!sig || !stripeWebhookSecret) {
    console.error('Webhook: missing Stripe-Signature or STRIPE_WEBHOOK_SECRET');
    return res.status(400).send('Bad request');
  }

  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const eventType = event.type;
  
  // デバッグ: 受信したすべてのイベントをログに記録
  console.log('Webhook received:', eventType, {
    id: event.id,
    created: event.created,
    data: event.data ? {
      object: event.data.object ? {
        id: event.data.object.id,
        object: event.data.object.object
      } : null
    } : null
  });

  if (eventType === 'checkout.session.completed') {
    const session = event.data?.object;
    if (!session) {
      res.json({ received: true });
      return;
    }
    const email = getGoogleEmailFromSession(session);
    if (!email) {
      console.warn('checkout.session.completed: Google account email not found. custom_fields:', JSON.stringify(session.custom_fields));
      res.json({ received: true });
      return;
    }
    const normalized = String(email).trim().toLowerCase();
    if (normalized.length === 0) {
      res.json({ received: true });
      return;
    }
    const subscriptionId = (session.subscription && String(session.subscription)) || '';
    try {
      await upsertPaidUser(normalized, STATUS_ACTIVE, subscriptionId);
    } catch (err) {
      console.error('upsertPaidUser failed:', err);
      return res.status(500).send('Append failed');
    }
    res.json({ received: true });
    return;
  }

  if (eventType === 'customer.subscription.updated') {
    const subscription = event.data?.object;
    if (!subscription || !subscription.id) {
      res.json({ received: true });
      return;
    }
    const subId = String(subscription.id);
    const status = (subscription.status && String(subscription.status)) || '';
    try {
      await updateStatusBySubscriptionId(subId, status);
    } catch (err) {
      console.error('updateStatusBySubscriptionId failed:', err);
      return res.status(500).send('Update failed');
    }
    res.json({ received: true });
    return;
  }

  if (eventType === 'customer.subscription.deleted') {
    const subscription = event.data?.object;
    console.log('customer.subscription.deleted event received:', {
      subscriptionId: subscription?.id,
      customerId: subscription?.customer,
      status: subscription?.status,
      canceledAt: subscription?.canceled_at
    });
    
    if (!subscription || !subscription.id) {
      console.warn('customer.subscription.deleted: subscription.id is missing');
      res.json({ received: true });
      return;
    }
    const subId = String(subscription.id);
    try {
      // サブスクリプション削除時は status を 'canceled' に更新
      console.log('Updating status to canceled for subscription_id:', subId);
      await updateStatusBySubscriptionId(subId, 'canceled');
      console.log('Successfully updated status to canceled for subscription_id:', subId);
    } catch (err) {
      console.error('updateStatusBySubscriptionId (deleted) failed:', err);
      return res.status(500).send('Update failed');
    }
    res.json({ received: true });
    return;
  }

  if (eventType === 'customer.deleted') {
    const customer = event.data?.object;
    console.log('customer.deleted event received:', {
      customerId: customer?.id,
      email: customer?.email,
      deleted: customer?.deleted
    });
    
    // 注意: customer.deleted イベントでは subscription_id が直接取得できません
    // 通常、顧客を削除すると customer.subscription.deleted イベントが先に発生するため、
    // そちらで処理されます
    // ここではログのみ記録します
    console.warn('customer.deleted: subscription_id が取得できないため、customer.subscription.deleted で処理してください');
    
    res.json({ received: true });
    return;
  }

  // 未処理のイベントタイプをログに記録（デバッグ用）
  if (!['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.deleted'].includes(eventType)) {
    console.log('Unhandled event type:', eventType);
  }

  res.json({ received: true });
});

/**
 * Checkout Session から「アプリで使うGoogleアカウント」のメールを取得。
 * カスタムフィールド（custom_fields）の text 値を優先。なければ customer_email にフォールバック。
 */
function getGoogleEmailFromSession(session) {
  const customFields = session.custom_fields;
  if (Array.isArray(customFields) && customFields.length > 0) {
    for (const field of customFields) {
      const key = (field.key && String(field.key).trim()) || '';
      const matchKey = !googleAccountFieldKey || key === googleAccountFieldKey;
      if (field.text && field.text.value && matchKey) {
        const v = String(field.text.value).trim();
        if (v.length > 0) return v;
      }
      if (field.dropdown && field.dropdown.value && matchKey) {
        const v = String(field.dropdown.value).trim();
        if (v.length > 0) return v;
      }
    }
    // キー指定がなく、該当がなければ「最初の text カスタムフィールド」を使用
    if (!googleAccountFieldKey) {
      for (const field of customFields) {
        if (field.text && field.text.value) {
          const v = String(field.text.value).trim();
          if (v.length > 0) return v;
        }
      }
    }
  }
  return session.customer_email ?? session.customer_details?.email ?? session.customer_details?.customer_email ?? null;
}

/** Google Sheets API クライアントを取得 */
function getSheetsClient() {
  if (!spreadsheetId || !credentialsJson) {
    throw new Error('SPREADSHEET_ID or GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
  }
  const { google } = require('googleapis');
  let credentials;
  try {
    credentials = JSON.parse(credentialsJson);
  } catch (e) {
    throw new Error('Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
}

/** 1行目がヘッダー（A列に "email" を含む）ならデータ行は2行目以降 */
function getDataRows(rows) {
  if (!rows || rows.length === 0) return [];
  const first = (rows[0] && rows[0][0] && String(rows[0][0]).toLowerCase()) || '';
  if (first.includes('email')) return rows.slice(1);
  return rows;
}

/**
 * 「有料ユーザー」シートで該当メールの行を探し、status が 'active' のときのみ paid: true を返す。
 * 戻り値: { paid: boolean, status?: string }
 */
async function checkPaidUserEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return { paid: false };
  const { sheets } = getSheetsClient();
  const range = `'${SHEET_NAME}'!A:B`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = getDataRows(existing.data.values || []);
  for (const row of rows) {
    const colA = (row[0] && String(row[0]).trim()) || '';
    if (colA.toLowerCase() !== normalized) continue;
    const status = (row[1] && String(row[1]).trim()) || '';
    // B列が空の行は従来の「A列のみ」データとみなし active 扱い
    const effectiveStatus = status || STATUS_ACTIVE;
    return {
      paid: effectiveStatus.toLowerCase() === STATUS_ACTIVE,
      status: effectiveStatus || undefined,
    };
  }
  return { paid: false };
}

/**
 * スプレッドシート「有料ユーザー」に (email, status, subscription_id) を追加または更新。
 * A=email, B=status, C=subscription_id。同一 email が既にあればその行の B,C を更新。
 */
async function upsertPaidUser(email, status, subscriptionId) {
  const { sheets } = getSheetsClient();
  const range = `'${SHEET_NAME}'!A:C`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const allRows = existing.data.values || [];
  const rows = getDataRows(allRows);
  const headerOffset = allRows.length - rows.length;
  const normalized = String(email).trim().toLowerCase();
  const subId = subscriptionId ? String(subscriptionId).trim() : '';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const colA = (row[0] && String(row[0]).trim()) || '';
    if (colA.toLowerCase() === normalized) {
      const rowIndex = headerOffset + i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${SHEET_NAME}'!B${rowIndex}:C${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[status, subId]] },
      });
      console.log('upsertPaidUser: updated row', rowIndex, email, status, subId || '(no sub)');
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A:C`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[email, status, subId]] },
  });
  console.log('upsertPaidUser: appended', email, status, subId || '(no sub)');
}

/**
 * subscription_id（C列）で行を検索し、その行の status（B列）を更新する。
 */
async function updateStatusBySubscriptionId(subscriptionId, status) {
  if (!subscriptionId || !status) {
    console.warn('updateStatusBySubscriptionId: missing subscriptionId or status', { subscriptionId, status });
    return;
  }
  const { sheets } = getSheetsClient();
  const range = `'${SHEET_NAME}'!A:C`;
  console.log('updateStatusBySubscriptionId: searching for subscription_id', subscriptionId, 'in range', range);
  
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const allRows = existing.data.values || [];
  const rows = getDataRows(allRows);
  const headerOffset = allRows.length - rows.length;
  const subId = String(subscriptionId).trim();
  
  console.log('updateStatusBySubscriptionId: found', rows.length, 'data rows (excluding header)');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const colC = (row[2] && String(row[2]).trim()) || '';
    console.log('updateStatusBySubscriptionId: checking row', i + 1, 'subscription_id:', colC, 'match:', colC === subId);
    if (colC === subId) {
      const rowIndex = headerOffset + i + 1;
      console.log('updateStatusBySubscriptionId: found matching row at index', rowIndex, 'updating status to', status);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${SHEET_NAME}'!B${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[status]] },
      });
      console.log('updateStatusBySubscriptionId: successfully updated row', rowIndex, 'subscription_id', subId, '-> status', status);
      return;
    }
  }
  console.warn('updateStatusBySubscriptionId: no row found for subscription_id', subId, 'Available subscription_ids:', rows.map(r => r[2]).filter(Boolean));
}

/**
 * customer_id で行を検索し、その行の status（B列）を更新する。
 * 注意: customer.deleted イベントでは subscription_id が取得できない場合があるため、
 * この関数は限定的に使用されます。通常は customer.subscription.deleted イベントで処理されます。
 */
async function updateStatusByCustomerId(customerId, status) {
  if (!customerId || !status) return;
  // customer.deleted イベントでは subscription_id が直接取得できないため、
  // この関数は実装が困難です。代わりに customer.subscription.deleted イベントを使用してください。
  console.warn('updateStatusByCustomerId: customer.deleted イベントでは subscription_id が取得できないため、この関数は使用されません。customer.subscription.deleted イベントで処理してください。');
}

if (!stripeWebhookSecret || !spreadsheetId || !credentialsJson) {
  console.warn('Missing env: STRIPE_WEBHOOK_SECRET, SPREADSHEET_ID, or GOOGLE_APPLICATION_CREDENTIALS_JSON. Webhook will fail until set.');
}

app.listen(port, () => {
  console.log(`stripe-to-sheet listening on port ${port}`);
});
