/**
 * Stripe Webhook → スプレッドシート & 有料判定API
 * Render にデプロイする。
 * - POST /webhook: Stripe の Webhook 受信 → 「有料ユーザー」シートにメール追記
 * - GET /check?email=xxx: 有料判定（「有料ユーザー」A列にメールがあれば { paid: true }）
 *
 * 環境変数:
 *   STRIPE_WEBHOOK_SECRET   - Stripe ダッシュボードの Webhook 署名シークレット
 *   SPREADSHEET_ID          - 有料ユーザー一覧のスプレッドシート ID
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON - サービスアカウント鍵 JSON の文字列（1行にしたもの）
 */

const express = require('express');
const Stripe = require('stripe');

const SHEET_NAME = '有料ユーザー';

const app = express();
const port = process.env.PORT || 3000;

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const spreadsheetId = process.env.SPREADSHEET_ID;
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

// Webhook ルートだけ生 body で受け取る（署名検証のため）
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'stripe-to-sheet' });
});

/**
 * 有料判定: GET /check?email=xxx → { paid: true/false }
 */
app.get('/check', async (req, res) => {
  const email = (req.query.email && String(req.query.email).trim()) || '';
  const result = { paid: false };
  if (!email) {
    return res.json(result);
  }
  try {
    const paid = await checkPaidUserEmail(email);
    result.paid = paid;
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
  let email = null;

  if (eventType === 'checkout.session.completed') {
    const obj = event.data?.object;
    if (obj) {
      email = obj.customer_email ?? obj.customer_details?.email ?? obj.customer_details?.customer_email;
    }
    if (!email) {
      console.warn('checkout.session.completed: email not found. Keys:', obj ? Object.keys(obj).join(',') : 'no object');
    }
  } else if (eventType === 'customer.subscription.created' || eventType === 'invoice.paid') {
    const dataObj = event.data?.object;
    if (dataObj) {
      email = dataObj.customer_email ?? dataObj.customer_details?.email ?? dataObj.customer_details?.customer_email;
    }
  }

  if (email) {
    email = String(email).trim().toLowerCase();
    if (email.length > 0) {
      try {
        await appendPaidUserEmail(email);
      } catch (err) {
        console.error('appendPaidUserEmail failed:', err);
        return res.status(500).send('Append failed');
      }
    }
  }

  res.json({ received: true });
});

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

/**
 * 「有料ユーザー」シートの A 列にメールが含まれるか判定
 */
async function checkPaidUserEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return false;
  const { sheets } = getSheetsClient();
  const range = `'${SHEET_NAME}'!A:A`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = existing.data.values || [];
  for (const row of rows) {
    const v = (row[0] && String(row[0]).trim()) || '';
    if (v.toLowerCase() === normalized) return true;
  }
  return false;
}

/**
 * スプレッドシート「有料ユーザー」の A 列にメールを1行追加（重複は追加しない）
 */
async function appendPaidUserEmail(email) {
  const { sheets } = getSheetsClient();

  const range = `'${SHEET_NAME}'!A:A`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = existing.data.values || [];
  const normalized = email.toLowerCase();
  for (const row of rows) {
    const v = (row[0] && String(row[0]).trim()) || '';
    if (v.toLowerCase() === normalized) {
      console.log('appendPaidUserEmail: already exists, skip:', email);
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[email]] },
  });
  console.log('appendPaidUserEmail: appended:', email);
}

if (!stripeWebhookSecret || !spreadsheetId || !credentialsJson) {
  console.warn('Missing env: STRIPE_WEBHOOK_SECRET, SPREADSHEET_ID, or GOOGLE_APPLICATION_CREDENTIALS_JSON. Webhook will fail until set.');
}

app.listen(port, () => {
  console.log(`stripe-to-sheet listening on port ${port}`);
});
