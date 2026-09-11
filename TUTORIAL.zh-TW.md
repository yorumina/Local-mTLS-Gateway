# Local mTLS Gateway：繁中快速教學

這個 sidecar 只在本機 `127.0.0.1` 提供 OpenAI-compatible API，再用 HTTPS + 既有 client identity 連到上游。它不會監聽區網、不會自動送出預設 prompt，也不會把憑證內容複製進專案。

## 1. 準備

- Windows
- Node.js 20.11 以上
- 上游核發的 PEM（憑證 + private key）或 PFX identity
- 一個只給本機 sidecar 使用、至少 16 字元的 `SIDECAR_API_KEY`

憑證、private key、PFX 與 passphrase 請放在專案資料夾外；不要貼到 README、source、issue 或命令列參數。

## 2. 建立本機設定

在專案根目錄執行：

```powershell
Copy-Item .env.example .env.local
```

編輯 `.env.local`，至少填入：

```text
SIDECAR_API_KEY=<自行產生的本機隨機值>
MTLS_PFX_FILE=<專案外的絕對路徑>
MTLS_PASSPHRASE=<若 PFX 有密碼才填>
```

若使用 PEM，改填 `MTLS_CERT_FILE` 與 `MTLS_KEY_FILE`，並把 `MTLS_PFX_FILE` 留白。正式模式必須使用 HTTPS 上游；不要開啟 `SIDECAR_TEST_MODE`。

## 3. 檢查與啟動

```powershell
npm run check
node --env-file=.env.local src/server.mjs
```

成功後：

- Proxy：`http://127.0.0.1:8787/v1`
- Models：`GET /v1/models`
- Chat：`POST /v1/chat/completions`
- TTS：`POST /v1/audio/speech`

每個代理請求都要帶 `Authorization: Bearer <SIDECAR_API_KEY>`。sidecar 不會替你填入模型、prompt 或 TTS input；那些內容由呼叫端自行提供。

## 4. Control Panel（可選）

```powershell
npm run control
```

開啟 `http://127.0.0.1:8790`。Control Panel 與 proxy 是不同 process，只能 loopback 存取；secret 只顯示是否已設定，不會回傳原值。

## 5. 測試

```powershell
npm run test:config
npm run test:control
npm run smoke
```

`npm run smoke` 只使用暫時的 loopback mock、假 key 與測試輸入，不能證明真實上游、Cloudflare mTLS 或模型服務已可用。

## 6. 開源前檢查

確認 `.env.local`、`.sidecar.local.json`、憑證檔、log 與測試暫存檔沒有被 Git 追蹤：

```powershell
git status --short --ignored
git ls-files .env.local .sidecar.local.json
```

第二個指令應該沒有輸出。提交前也請檢查 diff，不要提交任何 API key、private key、PFX passphrase 或完整憑證。
