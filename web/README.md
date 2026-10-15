# Gold Daily — 每日黃金價格追蹤與 LINE 推播

個人使用的金價追蹤工具：每天定時取得金價、存歷史快照、推播 LINE 每日行情，漲跌達門檻時另外提醒。

> **目前狀態（2026-10-14）**
> - 正式行情來源採用 **GoldAPI.io 免費方案**（每月 100 次），已實作並以假回應測試；填入 `GOLD_PRICE_API_KEY` 後才會實際呼叫。沒有金鑰時可用 Mock Provider（畫面與推播都會標示「模擬資料」）。
> - 預設查價：交易日 09:00（每日推播）＋ 21:30（盤中檢查），週末不推播不查價，每月約 44 次。
> - 功能：每日推播、百分比異動提醒、到價提醒（觸發一次就自動關閉）、LINE 與行情 API 的額度保護。
> - LINE、Supabase、排程都已實作，但要你提供帳號與金鑰後才會實際運作（見〈需要你提供的資料〉）。

視覺設計稿在 `../design/`（純 HTML），本專案的樣式由 `design/assets/styles.css` 複製到 `src/app/design.css`。

---

## 架構

| 層 | 內容 |
|---|---|
| 前端 | Next.js 16 App Router + TypeScript + Tailwind 4；頁面：儀表板 `/`、歷史資料 `/history`、推播設定 `/settings`、系統狀態 `/status`、登入 `/login` |
| 行情來源 | `src/lib/gold/`：`GoldPriceProvider` 介面（`getLatestPrice` / `getHistoricalPrice` / `getProviderStatus`），實作有 `GoldApiProvider`（正式）與 `MockGoldPriceProvider`；未設定或不支援的來源一律顯示「尚未設定正式行情來源」，不會偷用 Mock。`budget.ts` 是查價次數保護 |
| 資料 | `src/lib/store/`：`Store` 介面，`SupabaseStore`（正式）與 `MemoryStore`（測試、沒有 Supabase 的本機開發） |
| LINE | `src/lib/line/`：Push API、額度查詢；重試沿用 `X-Line-Retry-Key`。訊息格式在 `messages.ts`（每日、異動、到價提醒共用同一組格式化函式） |
| 走勢圖 | `/api/chart/<日期>-compact.png`（每日卡片用的精簡版）與 `/api/chart/<日期>.png`（完整版，舊訊息仍會用到）：用資料庫的每日快照畫近 30 個交易日，放在每日卡片裡（LINE 只算 1 則），不會多查價。LINE 的伺服器要能直接抓，所以不需登入；只畫已存在的日期，其他網址一律 404，同一天的圖交給 CDN 快取。網址要是 https 才會附圖（本機不附）。字型是 `src/assets/fonts/` 的 Noto Sans TC 子集（SIL OFL） |
| LINE webhook | `/api/line/webhook`：好友傳「ID」時回覆他自己的 User ID（加入推播名單用）。用 `LINE_CHANNEL_SECRET` 驗證簽章，沒設定就一律拒絕；不保存任何 ID 或訊息 |
| 排程工作 | `src/lib/jobs/`：每日行情 `daily.ts`、盤中檢查 `intraday.ts`、額度同步 `maintenance.ts`；只依賴介面，所以可以用假的 LINE 與記憶體資料完整測試 |
| 排程 API | `/api/cron/daily`、`/api/cron/intraday`、`/api/cron/quota-sync`，GET / POST 都可，需 `Authorization: Bearer <CRON_SECRET>` |
| 管理介面保護 | `src/proxy.ts`＋每個 Server Action 都再檢查一次；`ADMIN_PASSWORD`＋`SESSION_SECRET` 簽的 httpOnly cookie |

時間：資料庫全部存 UTC（timestamptz），排程判斷與畫面顯示用 Asia/Taipei。LINE 訊息額度依 LINE 規則用日本時間計月。

---

## 本機開發

```bash
cd gold-daily/web
npm install
cp .env.example .env.local     # 至少設 GOLD_PRICE_PROVIDER=mock 與 CRON_SECRET
npm run dev                    # http://localhost:3000
```

- 沒設定 Supabase 時用記憶體存資料（頁面頂端會提示），**重啟就清空**。
- 沒設定 `ADMIN_PASSWORD` 時，本機開發不需登入（頁面會提示）；正式環境沒設定則管理介面鎖住。
- 沒設定 LINE 時，推播事件會記錄為「未發送：LINE 尚未連線」，訊息內容仍可在推播設定頁預覽。

用 Mock Provider 完整試一遍：

1. 系統狀態頁 →「回填近 90 天（模擬資料）」，產生走勢圖用的歷史快照。
2. 「立即執行每日排程」→ 寫入今天的每日快照並產生每日推播事件（今天已處理過就不會重複）。
3. 推播設定頁 →「測試情境」選「正常波動」→ 系統狀態「立即執行盤中檢查」建立今天的基準價。
4. 切到「急漲」或「急跌」再執行盤中檢查 → 產生上漲／下跌提醒；再執行一次 → 同一筆報價不會重複提醒，冷卻時間內只記一筆「冷卻中」。
5. 推播設定頁 → 到價提醒新增一個「漲到 1000 以上」→ 執行盤中檢查 → 觸發一次後自動關閉，可以「重新啟用」。
6. 切到「來源未更新」或「來源中斷」→ 看過期警告、排程失敗與「最近一次錯誤」。測完切回「正常波動」。

想看查價次數保護的畫面，可以在 `.env.local` 設 `MOCK_MONTHLY_QUOTA=100`，讓 Mock 模擬 GoldAPI 的每月上限。

也可以直接呼叫排程 API：

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/daily
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/intraday
```

## 測試

```bash
npm test            # Vitest，114 個測試
npm run typecheck   # tsc --noEmit
npm run lint
```

測試只用假的 LINE（`FakeLine`）、假的 GoldAPI 回應、記憶體資料與 Mock Provider，**不會連到真的 LINE、Supabase、GoldAPI 或任何行情來源**（路由測試也會把相關環境變數清空）。涵蓋：行情解析、漲跌計算、無效／零值、過期判斷、缺少前一交易日、上漲／下跌觸發、未達門檻、冷卻時間、排程重跑不重複推播、LINE 失敗與重試（含 retry key 沿用）、缺少環境變數、未授權排程 API、Mock 與正式來源的區分、LINE 額度保護、LINE 計費月份切換、訊息格式；第 2 版另外涵蓋 GoldAPI 解析與單位核對、查價次數保護、固定時間查價、週末不推播、到價提醒。

兩個 migration 另外用 PGlite（真的 Postgres）各跑兩次驗證過：可重複執行、唯一索引、check 約束、排程鎖、到價提醒只觸發一次、RLS。

---

## 資料庫（Supabase）

1. 建立 Supabase 專案（免費方案即可）。
2. SQL Editor **依序**執行（都可重複執行）：
   1. `supabase/migrations/20261014000000_init.sql`
   2. `supabase/migrations/20261015000000_targets_and_budget.sql`（固定時間查價、週末、到價提醒、查價紀錄）
3. 把 Project URL 與 `service_role` key 填進 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。

所有資料表都開 RLS 且沒有任何 policy：瀏覽器拿不到資料，只有伺服器端用 service role 存取。`SUPABASE_ANON_KEY` 目前沒有使用。

### 資料表

| 資料表 | 用途 |
|---|---|
| `gold_price_snapshots` | 有效行情快照。`unique(source, symbol, quote_timestamp)` 防止重複寫入；`daily_date` 標記「某天的每日快照」，部分唯一索引保證每天最多一筆 |
| `notification_settings` | 推播與提醒設定（單列，id = 1） |
| `notification_events` | 通知事件：觸發、發送、重試；`unique(idempotency_key)` 去重，`line_retry_key` 重試時沿用 |
| `job_runs` | 排程執行紀錄 |
| `job_locks` | **規格外新增**：同一種工作同時只跑一個（`try_acquire_job_lock`），並記錄排程最後一次被呼叫的時間，系統狀態頁用來判斷排程是否正常 |
| `line_quota_syncs` | **規格外新增**：每次向 LINE 官方查詢訊息用量的結果，額度保護與成本透明都靠它 |
| `price_targets` | **規格外新增**（到價提醒）：目標價、方向、狀態（啟用／已觸發／已取消）；綁定建立時的來源與商品，不會被其他來源的價格觸發 |
| `provider_calls` | **規格外新增**：每次呼叫行情 API 前記一筆，用來計算 GoldAPI 免費方案的每月次數 |

`notification_settings` 另外多了 `line_plan`、`monthly_message_quota`、`quota_safety_buffer`（額度設定）、`intraday_mode`、`check_times`、`skip_weekends`（查價時間）與 `mock_scenario`（Mock 測試情境）。`notification_events.event_type` 增加 `target`（到價提醒）。

### 去重與防重複推播

- 每日推播：事件鍵 `daily:YYYY-MM-DD`（台北日期），同一天只會有一筆；排程重跑、手動執行都不會重送。
- 異動提醒：事件鍵 `alert:<方向>:<來源>:<商品>:<報價時間>`，同一筆報價只處理一次；同方向在冷卻時間內只記一筆「冷卻中・未發送」。
- 發送重試：單次執行最多 3 次（只重試 5xx 與逾時），累計最多 6 次；全部沿用同一個 `X-Line-Retry-Key`，LINE 在 24 小時內會對已接受的請求回 409，系統視為已送出，不會重複推播。超過 24 小時不再重試。
- 判斷是否已送出都查資料庫，不依賴記憶體變數，系統重啟也不會重複處理。

---

## LINE 設定

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號，方案選「輕用量」（免費，每月 200 則）。
2. 帳號設定 → Messaging API → 啟用，建立或選擇 Provider。
3. 到 [LINE Developers Console](https://developers.line.biz/console/) 打開這個頻道：
   - **Messaging API** 分頁 → Channel access token → Issue，填入 `LINE_CHANNEL_ACCESS_TOKEN`。
   - **Basic settings** 分頁 → 最下方「Your user ID」（`U` 開頭加 32 個字元），填入 `LINE_USER_ID`。
4. 用自己的 LINE 掃描官方帳號的 QR code 加為好友（封鎖官方帳號就收不到）。
5. 部署後到「推播設定」按「發送測試推播」。LINE 收到「Gold Daily 測試推播」、系統狀態頁的額度同步成功，就代表設定完成。

Token 只放在伺服器端環境變數，不會出現在原始碼、前端或 API 回應；畫面只顯示「已設定」與 User ID 末 4 碼。

### 推播給多人（指定名單）

推播只送給 `LINE_USER_ID` 裡的人，**加了官方帳號好友不代表會收到**。多人時用逗號分隔，系統用 multicast 一次送給名單上所有人（同樣沿用 retry key 去重）。LINE 依收件人數計算額度：2 人時每次推播用掉 2 則，額度保護也會依人數保留每日推播的份量；剩餘則數不夠送給所有人時整則不送，不會只送一部分人。

取得別人的 User ID（LINE 後台只看得到自己的）：

1. Vercel 加上環境變數 `LINE_CHANNEL_SECRET`（Basic settings → Channel secret，存成 Sensitive）並重新部署。
2. LINE Developers Console → **Messaging API** 分頁 → Webhook URL 填 `https://<你的網域>/api/line/webhook` → Verify → 打開 **Use webhook**。LINE Official Account Manager 的「回應設定」也要開啟 Webhook。
3. 請對方加官方帳號好友後傳「ID」，官方帳號會回覆他自己的 User ID（回覆不算額度；系統不保存任何人的 ID 或訊息）。
4. 把 ID 加進 Vercel 的 `LINE_USER_ID`（例如 `U你的ID,U對方的ID`）並重新部署。拿到 ID 後要關掉 webhook 也可以，不影響推播。

### 每日推播的樣式

每日推播是卡片（Flex Message）：漲跌上色（漲紅、跌綠），走勢圖（精簡版，`/api/chart/<日期>-compact.png`）放在文字下方、「查看黃金走勢」按鈕上方。通知列與聊天列表顯示一行摘要（例如「💰黃金每日行情 4,139.68 USD ▼0.52%」）。同樣內容的純文字存在事件上；報價過期（當天沒有每日快照）或 LINE 拒絕卡片時改送純文字。卡片在補送、手動重試時從資料庫重建，數字跟原本一樣。異動提醒與到價提醒維持純文字。

### 訊息額度與費用保護

- 預設每月 200 則（可在推播設定調整成當期方案的額度）。
- 發送前會向 LINE 查詢官方用量（`GET /v2/bot/message/quota`、`/quota/consumption`），與本地紀錄取剩餘較少的那個。官方數字是概略值，而且包含從官方帳號後台送出的訊息。
- 每日推播優先：異動提醒與測試推播要保留「本月剩餘天數 × 推播人數 ＋ 安全緩衝」。每次推播用掉「推播人數」則。
- 查不到官方用量（或超過 6 小時沒同步成功）就視為額度不足，暫停推播並在畫面上顯示原因。
- 不會自動升級方案、不會加購。LINE 回 429（可能是額度用完）不重試。
- 計費月份用日本時間：台灣時間月底最後一天 23:00 之後送出的算下個月（[LINE 說明](https://help2.line.me/official_account_tw/ios/categoryId/20006396/3/pc?lang=zh-Hant)）。

2026-11-01 起台灣方案（[公告](https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/)，未稅）：輕用量 NT$0／200 則（不能加購）、中用量 NT$1,000／3,000 則（不能加購）、高用量 NT$1,400／6,000 則（可加購）。

---

## 排程

| 工作 | 端點 | 建議頻率 | 說明 |
|---|---|---|---|
| 每日行情 | `/api/cron/daily` | 每 15 分鐘 | 到了「每日推播時間」之後的第一次呼叫才執行；今天處理過就直接回 `not_due`；週末不推播時回 `disabled`。查到的價格同時判斷百分比提醒與到價提醒 |
| 盤中檢查 | `/api/cron/intraday` | 每 15 分鐘 | 依設定決定要不要真的查價：**固定時間**（預設 21:30，每個時段只查一次）、固定間隔（15／30／60 分鐘）或不檢查 |
| 額度同步 | `/api/cron/quota-sync` | 每小時 | 發送前也會自動同步，這支讓畫面數字保持新鮮 |

因為是否執行由 API 依設定決定，在管理介面改推播時間或查價時間，**不用改排程**。沒到期的呼叫不會呼叫行情 API，不會用掉 GoldAPI 的次數。

提醒只在查價的時間點判斷：價格在兩次查價之間碰到門檻又回去，會漏掉。這是免費方案（每月 100 次）的取捨。

### Vercel Cron 的限制

Vercel Hobby（免費）方案的 Cron 每天最多一次，而且只精確到小時（`0 1 * * *` 可能在 01:00–01:59 UTC 之間觸發），失敗不會重試（[文件](https://vercel.com/docs/cron-jobs/usage-and-pricing)）。所以：

- `vercel.json` 只設每日行情 `0 1 * * *`（台北 09:00–09:59）**當作備援**。
- **每 15 分鐘的盤中檢查無法用 Vercel Hobby 達成**，改用下面的 Supabase pg_cron。Vercel Pro（US$20／月）可以每分鐘觸發，但這個專案不需要。

### 主要排程：Supabase pg_cron + pg_net（免費）

1. Database → Extensions 啟用 `pg_cron` 與 `pg_net`。
2. 把網址與 `CRON_SECRET` 存進 Vault：
   ```sql
   select vault.create_secret('https://<your-app>.vercel.app', 'gold_daily_url');
   select vault.create_secret('<CRON_SECRET>', 'gold_daily_cron_secret');
   ```
3. 執行 `supabase/cron.sql`（建立呼叫函式與 3 個排程，可重複執行）。
4. 查結果：`select * from cron.job_run_details order by start_time desc limit 20;`

pg_net 預設逾時只有 2 秒，`cron.sql` 已改成 30 秒。每 15 分鐘的呼叫也會讓 Supabase 免費專案保持活動（免費專案 7 天沒活動會暫停）。

備案：[cron-job.org](https://cron-job.org/)（免費、可自訂 `Authorization` header）。不建議用 GitHub Actions 的 schedule（可能延遲或被略過，私有 repo 的分鐘數也不夠）。

---

## 部署（Vercel）

1. 把 repo 匯入 Vercel，Root Directory 設為 `web`。`vercel.json` 已把函式地區設在東京（`hnd1`），跟 Supabase 同一區，避免每次查資料庫都跨太平洋。
2. 在 Vercel 專案設定填環境變數（見 `.env.example`）：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_USER_ID`、`GOLD_PRICE_PROVIDER=goldapi`、`GOLD_PRICE_API_KEY`、`CRON_SECRET`、`ADMIN_PASSWORD`、`SESSION_SECRET`（`NEXT_PUBLIC_APP_URL` 可以不填：走勢圖網址會自動用 Vercel 的正式網域；改用自訂網域時再填）。秘密類的值請存成 Secret／Sensitive。
3. 部署後照〈排程〉設定 pg_cron。
4. 打開系統狀態頁確認：行情來源、排程最後呼叫時間、LINE 已設定、額度同步成功、設定檢查沒有問題。

`.env.local` 等真實環境檔已被 `.gitignore` 排除，只有 `.env.example` 會進版控。

---

## 行情來源

Truney 的金價圖（https://www.truney.com/gold-chart ）由 TradingView 提供，**沒有公開 API**。本系統不抓取該頁面，也不使用 TradingView 的內部請求。

**Truney 顯示的商品**：依 Wayback Machine 存檔的頁面原始碼，圖表是 XAU/USD 現貨，2023 年設定為 `OANDA:XAUUSD`、2024 年起為 `XAUUSD`；新台幣／公克是用 `XAUUSD × USDTWD ÷ 31.1035` 換算，不是台灣銀行的黃金存摺牌價。目前頁面擋自動存取，**現行設定待確認**。

**候選來源比較**（2026-10-14 查官方頁面；標「未確認」的項目沒有在官方頁面查到）：

| 來源 | 免費額度 | 更新 | 歷史 | 免費方案條款 | 最便宜付費 |
|---|---|---|---|---|---|
| [GoldAPI.io](https://www.goldapi.io/) | 每月 100 次 | 即時 | 90 天日線 | 條款未確認（需自行閱讀） | US$99／月 |
| [MetalpriceAPI](https://metalpriceapi.com/pricing) | 每月 100 次 | 免費版延遲一天 | 365 天 | 僅限個人評估、不可商用 | US$5／月（年繳） |
| [Metals-API](https://metals-api.com/pricing) | 額度未公開 | 每 10 分鐘 | 有 | 僅限個人使用與測試 | US$19.99／月（2,500 次） |
| [Alpha Vantage](https://www.alphavantage.co/documentation/) | 每天 25 次 | 未說明延遲 | 日／週／月 | 個人非商業（未確認） | US$49.99／月 |
| [Twelve Data](https://twelvedata.com/pricing) | 每天 800 次 | — | — | 免費版只能測試、不能正式使用 | US$29 起 |
| [台灣銀行開放資料](https://data.gov.tw/dataset/26404) | 免費 | 一年更新一次 | 2015 年起 | 政府資料開放授權，可商用、需標示來源 | — |

沒有免費來源能合法支援每 15 分鐘查價，所以 **2026-10-14 決定採用 GoldAPI.io 免費方案，每個交易日查 2 次（09:00、21:30）**。

### GoldAPI.io（目前採用）

- **申請**：到 https://www.goldapi.io 註冊（免信用卡），在 Dashboard 取得 API key，填入 `GOLD_PRICE_API_KEY`，並設 `GOLD_PRICE_PROVIDER=goldapi`。註冊即表示同意它的服務條款。
- **服務條款**（[2026-08-21 版](https://www.goldapi.io/blog/terms-of-service)）重點：可在自己的應用程式中接收、處理與顯示資料；不可轉售或轉發 API、不可把金鑰給第三方或放在公開的前端／repo、不可用多個帳號規避額度。免費方案沒有「僅限測試」的限制。這是對條款的整理，不是法律意見。
- **免費方案（Sandbox）**：每月最多 100 次請求，報價每 2 秒更新，有每日歷史價格。
- **端點**：最新價 `GET /api/price/XAU/USD`、歷史 `GET /api/history/XAU/USD?from=&to=`（一次最多 90 天，只算 1 次）；驗證用 `x-access-token` header。
- **商品**：XAU/USD 現貨，上游為 `FOREXCOM:XAUUSD`。Truney 圖表是 OANDA／TradingView 的 XAUUSD，兩者數字可能有小差異。
- **2026-10-14 實測確認**（真實回應存在 `src/lib/gold/__fixtures__/`，測試用它跑，不會再呼叫 API）：
  - 最新價回應有 `"unit": "troy_ounce"`，`price` 是買價（bid）與賣價（ask）的中價。系統以 `unit` 為準，再用 `price_per_unit.gram`（＝價格 ÷ 31.1035）交叉核對，不符就拒絕寫入。
  - 歷史端點在週末會沿用週五的價格；系統寫入前會排除週六、週日。
  - 歷史端點的「每日價格」不是收盤價（例如 10/13 為 4,182.45，但 10/14 回應的前一收盤是 4,161.03），只用在回填走勢與第一次計算前一交易日；之後的每日快照都是 09:00 的即時報價。
- **延遲報價**：GoldAPI 沒有提供延遲標記，畫面顯示「供應商未提供」。

### 查價次數保護（`src/lib/gold/budget.ts`）

- 每次呼叫 GoldAPI 前先在 `provider_calls` 記一筆（失敗也算），以本地紀錄計數；不自動呼叫 `/api/stat`，因為它也可能算一次。
- 每月最多使用 90 次（保留 10 次給時區差異與手動查詢）。
- 每日推播優先：盤中檢查、手動執行、回填要先保留「本月剩餘每日推播次數」。
- 10 分鐘內查過的有效報價直接沿用；查價失敗不自動重試；每日推播的 LINE 補送只重送同一則訊息，不重新查價；行情來源中斷時一天最多試 3 次。
- 系統狀態頁顯示本月已用次數、保留量與暫停原因。

新增其他正式 Provider 的方式：在 `src/lib/gold/` 實作 `GoldPriceProvider`（`id` 要等於報價的 `source`，有每月上限就回傳 `monthlyCallQuota`），在 `registry.ts` 註冊，並用真實回應確認商品代號、幣別、單位與時間戳。

---

## 需要你提供的資料

| 項目 | 用途 | 狀態 |
|---|---|---|
| GoldAPI.io 的 API key | 正式行情來源（已決定採用免費方案） | 待註冊 |
| Supabase 專案 URL 與 service role key | 保存資料、pg_cron 排程 | 待提供 |
| LINE Channel Access Token 與 User ID | 推播 | 待提供 |
| Vercel 專案（或其他部署平台） | 上線 | 待提供 |
| `CRON_SECRET`、`ADMIN_PASSWORD`、`SESSION_SECRET` | 排程授權與管理介面登入 | 部署時自行產生 |

## 已知限制

- 「每日」以台北日期切換；金市實際交易日由供應商資料決定（前一交易日是資料庫中前一個有效的每日快照，所以週一會對照上週五）。
- 異動提醒與到價提醒只在查價時間判斷（預設每個交易日 09:00 與 21:30），無法在價格觸及門檻的當下通知；不做盤中檢查時，百分比提醒改成與前一交易日比較。
- 到價提醒觸發一次就關閉；如果當時 LINE 未連線或額度不足，事件會記為未發送，可到系統狀態頁重試，或在推播設定頁重新啟用。
- 查價次數以 UTC 日曆月計算（GoldAPI 文件沒有載明時區），另外保留了 10 次緩衝。
- LINE 官方用量是概略值；本地紀錄只算本系統送出的訊息。
- 沒有 Supabase 時的記憶體模式只適合本機，正式環境請一定設定 Supabase。
