# Yorumina mTLS AI sidecar

這個資料夾提供一個 Windows/Node.js 本機 sidecar，讓 OpenCode 與其他本機專案透過 loopback 使用 Yorumina 的 Chat、Models 與 TTS API，再由 sidecar 帶著既有 client certificate 連到受 Cloudflare mTLS 保護的服務。

## 固定資料流

```text
Local API clients
  -> http://127.0.0.1:8787
  -> local bearer API-key check
  -> HTTPS client certificate
  -> https://llm.yorumina.com
  -> /v1/chat/completions -> Qwen3.6 35B-A3B
  -> /v1/models          -> Auth Gateway
  -> /v1/audio/speech    -> nyako-tts
```

`AGENTS.md` 是本資料夾的強制工作契約；`npm run check` 會檢查關鍵安全不變條件。

管理介面是獨立 process，不會擴大 proxy 的路由：

```text
Browser -> http://127.0.0.1:8790 -> Yorumina Sidecar Control
                                      -> safe settings / diagnostics
                                      -> managed sidecar lifecycle
```

Proxy 固定使用 `127.0.0.1:8787`，Control Panel 固定使用 `127.0.0.1:8790`。兩者都不接受 LAN 或公開介面連線。

## 安裝與執行

需求：Node.js 20.11 以上。本專案沒有第三方 runtime dependency。

1. 複製範例設定，並只在本機編輯被 `.gitignore` 忽略的 `.env.local`：

   ```powershell
   Copy-Item .env.example .env.local
   ```

2. 在 `.env.local` 設定一個至少 16 字元的本機 `SIDECAR_API_KEY`，以及既有 client identity 的路徑：

   - PEM：`MTLS_CERT_FILE` + `MTLS_KEY_FILE`
   - 或 PFX：`MTLS_PFX_FILE`，需要密碼時設定 `MTLS_PASSPHRASE`
   - 使用私有 CA 時才設定 `MTLS_CA_FILE`

   憑證與 private key 應留在 sidecar 資料夾之外；不要把真實內容貼進任何 markdown、source 或 terminal output。

3. 在此資料夾執行：

   ```powershell
   npm run check
   node --env-file=.env.local src/server.mjs
   ```

   預設 listener 是 `127.0.0.1:8787`。啟動失敗通常表示 API key、HTTPS 上游或 client identity 尚未完整設定；這是預期的 fail-closed 行為。


## Client 設定

把 provider 的 base URL 設為：

```text
http://127.0.0.1:8787/v1
```

把 client 的 API key 設成與 `SIDECAR_API_KEY` 相同的本機值。這個值只是 sidecar 的 inbound gate，不是本專案內保存的 OpenAI Platform key。

OpenCode 的範例設定保留在 `opencode.json`。目前宣告 `131072` input context 與 `32768` output；output 是 OpenCode 預留的最大生成量，不等於 llama.cpp 的 thinking budget。實際 thinking budget 由上游 llama.cpp 啟動或每次請求的 `thinking_budget_tokens` 控制。

若 gateway 需要另一個 bearer token，設定 `UPSTREAM_API_KEY`；sidecar 會使用它向上游認證，而不會把本機 inbound token 傳給上游。若 `UPSTREAM_API_KEY` 留白，已驗證的 inbound bearer token 才會被轉送給 gateway。

## 代理範圍

只允許下列必要路由：

| Method | Path |
| --- | --- |
| GET | `/v1/models` |
| POST | `/v1/chat/completions` |
| POST | `/v1/completions` |
| POST | `/v1/responses` |
| POST | `/v1/embeddings` |
| POST | `/v1/audio/speech` |

`/v1/audio/speech` 的 binary audio response 會串流轉送，不會轉成 JSON 或文字。`/healthz` 與 `/readyz` 是本機診斷端點，不會轉送到 gateway。所有其他路徑都會被拒絕。

TTS client 使用：

```text
POST http://127.0.0.1:8787/v1/audio/speech
Authorization: Bearer <SIDECAR_API_KEY>
Content-Type: application/json
```

Request body 會以原始 bytes 轉送，sidecar 不會改寫 `model`、`input`、`voice`、`instructions`、`response_format`、`speed`、`stream_format` 或其他 JSON 欄位。以下是目前可用的請求範例；`response_format` 可由 client 按上游支援格式指定：

```json
{
  "model": "nyako-tts",
  "input": "要講的內容",
  "voice": "nyako",
  "instructions": "這一句的情緒和說話方式",
  "response_format": "mp3",
  "speed": 1.0,
  "stream_format": "audio"
}
```

真實 API key 不要寫入 source、README 或 URL。

## 驗證

```powershell
npm run check
npm run test:config
npm run test:control
npm run smoke
```

smoke test 只會啟動 loopback mock gateway，使用假 key，並以 `SIDECAR_TEST_MODE=true` 暫時跳過真實 client identity。它能驗證 API-key gate、路由白名單、request forwarding、JSON、SSE 與 binary audio response；它不能證明 Cloudflare mTLS、遠端 gateway、Qwen3.6 或 nyako-tts 已可用。

## Yorumina Sidecar Control

先完成 `.env.local` 的本機 secret 設定，再執行 `npm run control`，然後開啟 `http://127.0.0.1:8790`。介面包含 Overview、Connection、mTLS Identity、Limits、API Clients、Diagnostics 與 Settings / About。

介面可以修改上游 HTTPS URL、本機 proxy port、request body 上限、upstream timeout、PEM/PFX identity 類型與外部檔案路徑，並顯示 Chat、Models 與 TTS client endpoint。

非敏感設定寫入 gitignored 的 `.sidecar.local.json`。`SIDECAR_API_KEY`、`UPSTREAM_API_KEY` 與 `MTLS_PASSPHRASE` 仍保存在 environment / `.env.local`，介面只顯示 `Configured` 或 `Not configured`；更新 secret 是 write-only，瀏覽器、diff、log 與 API response 都不會取得原值。

`Apply & Restart` 會依序驗證設定、顯示安全 diff、寫入設定、執行 policy check、重新啟動受管理的 sidecar，再檢查 `/healthz`。若目前的 sidecar 不是由 Control Panel 啟動，介面不會強制終止它，而會明確顯示需要重新啟動。套用失敗會回復前一版設定。

Diagnostics 將 Configuration validation、Security policy check、Local sidecar health、loopback mock smoke test 與 real upstream HTTPS / mTLS diagnostic 分開顯示。Smoke test 不代表 Cloudflare mTLS、真實 gateway 或 Qwen 已驗證；只有 real upstream diagnostic 實際成功時，才能表示該次遠端 HTTPS/mTLS 連線成功。

## Windows 登入自動啟動與桌面捷徑

執行一次：

```powershell
.\install-windows-integration.ps1
```

它會建立目前使用者的 `Yorumina mTLS Sidecar` 登入排程，登入後在背景啟動 Control Panel 與它管理的 loopback sidecar。桌面只建立 `Yorumina Sidecar` 捷徑；點擊後啟動或開啟 Control Panel，不會自動啟動 OpenCode 或其他 client app。安裝程式會移除舊的 `OpenCode GB10` 捷徑與舊登入排程，避免重複啟動。

排程與捷徑都不含 API key、PFX passphrase 或憑證內容。

## 安全界線

- 不支援 HTTP 上游，除非是 smoke test 明確啟用的 loopback mock。
- 不接受非 `127.0.0.1` bind。
- 不把 authorization、cookie、body 或 private key 寫入 log。
- 不會自動部署或修改 Cloudflare、DNS、gateway、llama.cpp、模型或防火牆。
