# Local mTLS Gateway

這個專案提供一個 Windows/Node.js 本機 sidecar，讓 OpenCode 與其他本機專案透過 loopback 使用 OpenAI-compatible 的 Chat、Models 與 TTS API，再由 sidecar 帶著既有 client certificate 連到受 mTLS 保護的 HTTPS 上游。預設上游是 Yorumina，但可以由本機設定覆寫。

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
Browser -> http://127.0.0.1:8790 -> Local mTLS Gateway Control
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

OpenCode 的範例設定保留在 `opencode.json`。目前宣告 `131072` 總 context、`98304` input 與 `32768` output；output 是 OpenCode 預留的最大生成量，不等於 llama.cpp 的 thinking budget。實際 thinking budget 由上游 llama.cpp 啟動或每次請求的 `thinking_budget_tokens` 控制。對 OpenCode 相容性，sidecar 會在呼叫端未明確提供 `thinking_budget_tokens` 時，把 `reasoning_effort` 映射為 `none/off = 0`、`low = 512`、`medium = 2048`、`high = 8192`、`max = 32768`，並同步設定 `chat_template_kwargs.enable_thinking`；未提供 effort 的 default 模式保持模型預設。

範例啟用自動壓縮與工具輸出清理，並預留 `20000` tokens。OpenCode 1.18.15 在有 `limit.input` 時，以 `input - reserved` 判斷是否需要壓縮，因此這份設定約在已回報的總用量達 `78304` tokens 時觸發，替後續工具結果與摘要留空間。從其他專案（例如 Open Design）啟動時，必須在實際載入的全域設定中，對每個會使用的 GB10 模型別名設定相同上限；本資料夾的設定不會自動套用至其他專案。缺少 context 上限會讓此版本跳過自動壓縮判斷。

對三個文字生成路由的 HTTP 400、未壓縮 JSON 錯誤，sidecar 會將 `context_budget_exceeded` 補為 OpenCode 可識別的 `context_length_exceeded` 錯誤碼，保留 HTTP 400，讓 client 有機會執行壓縮恢復。辨識最多緩衝 64 KiB，其他錯誤、大型回應、成功 SSE 與音訊維持原樣。這項相容處理不會自行重送請求，也不保證已超過摘要可處理範圍的舊對話能恢復。

可用 `npm run smoke -- --opencode-bin "<OpenCode executable 的絕對路徑>"` 執行額外的真實 CLI／loopback mock 整合測試。測試使用暫存設定、假 key 與隔離資料庫，對照缺少上限、提前壓縮及超限後恢復。OpenCode 1.18.15 在超限後即使已完成摘要並繼續回答，CLI 仍會保留先前的 `ContextOverflowError` 事件並退出 `1`；依賴退出碼的呼叫端仍可能顯示失敗。提前壓縮的路徑可正常退出 `0`。這些測試不會呼叫真實 GB10。

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
  "input": "<要轉成語音的文字>",
  "voice": "nyako",
  "instructions": "<可選的語氣描述>",
  "response_format": "mp3",
  "speed": 1.0,
  "stream_format": "audio"
}
```

真實 API key 不要寫入 source、README 或 URL。

文件中的 Chat/TTS body 只是格式示例，不是啟動時會自動送出的預設輸入；sidecar 不會自行發送任何使用者內容。

## 驗證

```powershell
npm run check
npm run test:config
npm run test:control
npm run smoke
```

smoke test 只會啟動 loopback mock gateway，使用假 key，並以 `SIDECAR_TEST_MODE=true` 暫時跳過真實 client identity。它能驗證 API-key gate、路由白名單、request forwarding、JSON、SSE 與 binary audio response；它不能證明 Cloudflare mTLS、遠端 gateway、Qwen3.6 或 nyako-tts 已可用。

## Local mTLS Gateway Control

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

它會建立目前使用者的 `Local mTLS Gateway` 登入排程，登入後在背景啟動 Control Panel 與它管理的 loopback gateway。桌面只建立 `Local mTLS Gateway` 捷徑；點擊後啟動或開啟 Control Panel，不會自動啟動 OpenCode 或其他 client app。安裝程式會移除舊的捷徑與舊登入排程，避免重複啟動。

排程與捷徑都不含 API key、PFX passphrase 或憑證內容。

## 安全界線

- 不支援 HTTP 上游，除非是 smoke test 明確啟用的 loopback mock。
- 不接受非 `127.0.0.1` bind。
- 不把 authorization、cookie、body 或 private key 寫入 log。
- 不會自動部署或修改 Cloudflare、DNS、gateway、llama.cpp、模型或防火牆。
