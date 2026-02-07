# Stripe → Render (Node.js) → Google Sheets API → スプレッドシート

**流れ**: [Stripe] → Webhook → [Render API] → [Google Sheets API] → スプレッドシート

**Render** 上の Node.js で次の2つを担当します。

- **POST /webhook** … Stripe の Webhook 受信 → 「有料ユーザー」シートの A 列にメールを自動追加
- **GET /check?email=xxx** … 有料判定（「有料ユーザー」A 列にメールがあれば `{ paid: true }` を返す）

---

## 1. Google スプレッドシート用のサービスアカウント

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを選択（または新規作成）。
2. **API とサービス** → **ライブラリ** で「Google Sheets API」を検索し **有効化** する。
3. **API とサービス** → **認証情報** → **認証情報を作成** → **サービス アカウント** を選ぶ。
4. サービス アカウント名を入力して作成。**キー** タブで **鍵を追加** → **新しい鍵を作成** → **JSON** を選び、鍵ファイルをダウンロードする。
5. スプレッドシート「App一元管理セキュリティ」（有料ユーザー一覧）を開く。
6. **共有** で、サービス アカウントの **メールアドレス**（例: `xxx@project.iam.gserviceaccount.com`）を **編集者** として追加する。
7. ダウンロードした JSON を開き、**中身全体を 1 行の文字列** にしたものを控える（改行を削除した JSON）。Render の環境変数で使います。

---

## 2. Render にデプロイ

1. [Render](https://render.com/) にログインし、**New** → **Web Service** を選ぶ。
2. このリポジトリ（または `stripe-to-sheet` フォルダ）を接続する。
   - **Root Directory** に `stripe-to-sheet` を指定する（リポジトリ直下でない場合）。
3. 設定例:
   - **Name**: 例 `stripe-to-sheet`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Environment** で次の環境変数を追加する:

   | Key | Value |
   |-----|--------|
   | `STRIPE_WEBHOOK_SECRET` | Stripe の Webhook 署名シークレット（`whsec_...`） |
   | `SPREADSHEET_ID` | 有料ユーザー一覧のスプレッドシート ID（URL の `/d/` と `/edit` の間） |
   | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | 上記のサービス アカウント JSON を 1 行にした文字列 |

5. **Create Web Service** でデプロイする。
6. デプロイ後、**URL** が表示される（例: `https://stripe-to-sheet-xxx.onrender.com`）。
   - **Stripe の Webhook 送信先**: `https://あなたのサービス名.onrender.com/webhook`
   - **アプリの有料判定（checkUrl）**: `https://あなたのサービス名.onrender.com/check`

---

## 3. Stripe で Webhook 送信先を設定

1. [Stripe ダッシュボード](https://dashboard.stripe.com/) → **開発者** → **Webhook**（またはワークベンチの **イベントの送信先**）。
2. **エンドポイントを追加** で、**URL** に  
   `https://あなたのサービス名.onrender.com/webhook` を入力する。
3. **イベント** で `checkout.session.completed` を追加する（必要に応じて `invoice.paid` なども）。
4. 作成後、**署名シークレット**（`whsec_...`）をコピーし、Render の環境変数 `STRIPE_WEBHOOK_SECRET` に設定する（未設定なら設定し直す）。

---

## 4. 動作確認

1. Stripe のテスト決済（例: テストカード `4242 4242 4242 4242`）を完了する。
2. 数秒以内にスプレッドシート「有料ユーザー」の A 列にメールが 1 行追加されていれば成功。
3. Render の **Logs** で `appendPaidUserEmail: appended: ...` が出ていれば追記処理まで成功している。

**ヘルスチェック**: `GET https://あなたのサービス名.onrender.com/health` で `{"ok":true,"service":"stripe-to-sheet"}` が返ればサービスは起動しています。

**有料判定**: `GET https://あなたのサービス名.onrender.com/check?email=xxx@gmail.com` で `{"paid":true}` または `{"paid":false}` が返ります。アプリの `constants.js` の `PAID_PLAN_CONFIG.checkUrl` を `https://あなたのサービス名.onrender.com/check` に設定してください。

---

## 環境変数まとめ

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `STRIPE_WEBHOOK_SECRET` | ○ | Stripe Webhook の署名シークレット（`whsec_...`） |
| `SPREADSHEET_ID` | ○ | 有料ユーザー一覧のスプレッドシート ID |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | ○ | サービス アカウント鍵 JSON を 1 行にした文字列 |

---

## アプリ側の設定

`js/constants.js` の **`PAID_PLAN_CONFIG.checkUrl`** を **`https://あなたのサービス名.onrender.com/check`** に設定する。
