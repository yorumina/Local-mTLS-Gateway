# AGENTS.md — 強制工作契約

本檔是 `opencode-mtls-sidecar` 的強制規範。任何 agent、開發者或自動化程序在本資料夾內讀取、修改、執行或驗證檔案時，MUST 遵守以下條款。若需求與本檔衝突，先停止並回報衝突，不得自行放寬安全邊界。

## 0. 不可違反的停止條件

- MUST NOT 讀取、輸出、提交、寫入或貼出任何真實 API key、client private key、PFX passphrase、`.env.local` 內容或完整憑證。
- MUST NOT 把秘密放在 source code、README、測試 fixture、命令列參數、URL query、git commit、log 或錯誤回應中。
- MUST NOT 將 listener 綁到 `0.0.0.0`、區網 IP、公開介面或 IPv6 wildcard；此 sidecar 只能監聽 `127.0.0.1`。
- MUST NOT 關閉上游 TLS 憑證驗證、接受 HTTP 上游、加入 `NODE_TLS_REJECT_UNAUTHORIZED=0`，或以 insecure fallback 取代 mTLS。
- MUST NOT 把 client certificate/private key 複製進本資料夾或改寫既有憑證；只接受環境變數指向的外部檔案。
- MUST NOT 擴大代理路由、允許任意 URL、代理任意 HTTP method，或把 sidecar 變成通用 open proxy。
- MUST NOT 執行部署、DNS、Cloudflare、gateway、llama.cpp、遠端憑證或防火牆變更；本資料夾只負責本機 sidecar。

違反任何一項時，立即停止執行並說明哪一項阻止了工作。

## 1. 固定架構契約

資料流必須保持：

`OpenCode (OpenAI-compatible) -> 127.0.0.1:8787 -> HTTPS + existing client certificate -> https://llm.yorumina.com -> gateway -> llama.cpp/Qwen3.6`

- 本機入口預設且強制為 `http://127.0.0.1:8787`；OpenCode 的 base URL 應指向 `http://127.0.0.1:8787/v1`。
- 每個代理路由都必須驗證 `Authorization: Bearer <SIDECAR_API_KEY>`；缺少或不相等就回 `401`，不得匿名 proxy。
- 上游預設為 `https://llm.yorumina.com`，正式模式必須是 HTTPS，且 Node TLS options 必須明確保留 `rejectUnauthorized: true`。
- 正式模式必須提供 PEM client cert + private key，或 PFX identity；可選 private CA 只能透過 `MTLS_CA_FILE` 加入。
- 只允許 `/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/embeddings` 的必要 method。
- 不得把 inbound 的自訂 header、cookie、origin、forwarded-for 或 request body 寫入 log；只可轉送明確列出的相容 API headers。
- upstream API key 若另設 `UPSTREAM_API_KEY`，必須優先使用它；未設定時才可轉送已驗證的 inbound bearer token。

## 2. 變更流程

每次變更前後都必須：

1. 閱讀本檔與 `README.md`。
2. 執行 `npm run check`。
3. 只做最小必要 diff；保留使用者既有檔案與憑證位置。
4. 執行 `npm run smoke`；若需要真實 gateway，另行標註那是遠端驗證，不得把 mock 結果宣稱為 Cloudflare mTLS 已驗證。
5. 回報「已驗證」與「尚未驗證」兩類結果，不能把 listener/self-connect 或 mock smoke test 當成區網、Cloudflare、gateway 或 Qwen3.6 成功證據。

## 3. 測試邊界

`SIDECAR_TEST_MODE=true` 只能由 `scripts/smoke-test.mjs` 啟動 loopback mock gateway 使用。它可以暫時允許 HTTP mock 與不載入憑證，但不得作為正式啟動方式，也不得加入 `.env.local` 的 production 設定。

任何測試都必須使用假 key、loopback mock 與暫存 child process；測試輸出不得包含秘密。若真實憑證或 gateway 不可用，保留 fail-closed 行為並如實報告。

## 4. 完成定義

只有在 `npm run check` 與 `npm run smoke` 都通過，且未引入任何 secret、非 loopback listener、TLS bypass 或未授權路由時，才可宣稱本資料夾的本機實作完成。這不代表遠端 Cloudflare mTLS、gateway routing 或 llama.cpp/Qwen3.6 已完成部署。

## 5. Control Panel 強制契約

- Control Panel 必須是與 proxy 分離的 process，固定監聽 `127.0.0.1:8790`；不得把任何 UI 或 Control Panel API route 加入 `src/server.mjs`。
- `.sidecar.local.json` 只能儲存 URL、數值、檔案路徑與 identity type，必須保持 gitignored，且不得包含 API key、passphrase、憑證或 private key 內容。
- Control Panel 的 read API 只能回傳安全設定與 secret 的 boolean status。secret 更新必須是 write-only，response、diff、log 與錯誤訊息都不得回傳 secret value。
- 修改設定的 API 必須驗證 loopback Host、same-origin 與當次啟動產生的 session token；不得開放跨來源 mutation。
- 套用失敗必須回復上一版安全設定與 secret 檔案；不得留下半套用狀態。
- Control Panel 測試只能使用暫存目錄與假 secret，不得讀取真實 `.env.local`。
- `npm run smoke` 只代表 loopback mock path。只有獨立執行真實 upstream diagnostic 成功時，才可回報遠端 HTTPS/mTLS 可達；仍不得將其擴大解讀為 Qwen 回答品質驗證。
