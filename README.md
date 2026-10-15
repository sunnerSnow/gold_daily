<p align="center">
  <img src="web/src/assets/logo-mark.png" width="120" alt="Gold Daily">
</p>

<h1 align="center">Gold Daily</h1>

<p align="center">
  每個交易日早上 9 點，把國際金價做成一張卡片送到 LINE。<br>
  個人使用的黃金價格追蹤與 LINE 推播工具。
</p>

<p align="center">
  <a href="#line-推播">LINE 推播</a> ・
  <a href="#管理後台">管理後台</a> ・
  <a href="#功能">功能</a> ・
  <a href="#運作方式">運作方式</a> ・
  <a href="#技術與費用">技術與費用</a> ・
  <a href="web/README.md">安裝與部署</a>
</p>

---

## LINE 推播

<table>
  <tr>
    <td width="46%" valign="top">
      <img src="docs/images/line-card.png" alt="LINE 每日推播卡片">
    </td>
    <td valign="top">

**每日行情卡片**（每個交易日 09:00）

- 國際現貨黃金的最新價格（USD／金衡盎司）
- 漲跌金額與幅度，跟前一交易日比較：**漲紅、跌綠**
- 前一交易日價格、報價時間、資料來源、資料狀態
- 卡片裡附「近 30 個交易日」走勢圖，點圖可以放大
- 「查看黃金走勢」按鈕開啟 Truney 金價圖
- 通知列與聊天列表顯示一行摘要：<br>`💰黃金每日行情 4,139.68 USD ▼0.52%`

**提醒**（純文字）

- 🔔 **價格異動提醒**：比當天基準漲跌 ≥ 1%（門檻與冷卻時間可調）
- 🎯 **到價提醒**：漲到或跌到目標價時通知一次，之後自動關閉

預設群發給官方帳號的所有好友，加好友就會收到；也可以改成只送指定的人。

<sub>左圖依實際推播的卡片內容排版（2026/10/15 的真實數字），LINE 上的字型與間距以手機為準。</sub>

</td>
  </tr>
</table>

走勢圖由網站自己產生，只用資料庫裡的每日快照，不會多查價：

<p align="center">
  <img src="docs/images/chart-compact.png" width="680" alt="近 30 個交易日走勢圖">
</p>

---

## 管理後台

用密碼登入的網站，桌機與手機都能用。以下截圖都是正式環境的真實資料。

### 儀表板

<table>
  <tr>
    <td width="70%"><img src="docs/images/dashboard-desktop.png" alt="儀表板（桌機）"></td>
    <td><img src="docs/images/dashboard-mobile.png" alt="儀表板（手機）"></td>
  </tr>
</table>

最新金價與漲跌、下次查價時間、異動提醒的基準與門檻（目前價格落在哪裡一眼就看得到）、到價提醒、近 7／30／90 天走勢、最近的提醒事件與排程結果。

### 歷史資料

<table>
  <tr>
    <td width="70%"><img src="docs/images/history-desktop.png" alt="歷史資料（桌機）"></td>
    <td><img src="docs/images/history-mobile.png" alt="歷史資料（手機）"></td>
  </tr>
</table>

每個交易日一筆快照，可依日期與資料狀態篩選；沒取得有效報價的日子會明確標示，不補假資料。手機上表格自動改成一筆一張卡片，不用橫向滑動。

### 推播設定

<img src="docs/images/settings-desktop.png" alt="推播設定">

推播時間、盤中檢查時間、漲跌門檻與冷卻時間、基準規則、LINE 方案與安全緩衝、到價提醒。右側是每日推播預覽（含走勢圖），可以按「發送測試推播」看 LINE 上的實際樣子。

### 系統狀態

<img src="docs/images/status-desktop.png" alt="系統狀態">

行情來源、最近一次報價、排程是否正常、LINE 推播狀態、設定檢查（只顯示有沒有設定，不顯示金鑰）、LINE 額度（已用／每日推播保留／提醒可用），以及排程執行紀錄與通知事件（失敗可重試）。

---

## 功能

| | |
|---|---|
| **每日推播** | 交易日 09:00 查價、存快照、送出每日卡片；週末休市不推播 |
| **盤中檢查** | 預設 21:30 再查一次，判斷異動提醒與到價提醒（也可改成固定間隔或關閉） |
| **推播對象** | 預設群發給官方帳號所有好友；可改成只送指定的 User ID 名單 |
| **LINE 額度保護** | 依 LINE 官方用量與推播人數計算，優先保留每日推播的份量；不夠送給所有人就整則不送；不會自動升級或加購 |
| **行情額度保護** | GoldAPI 免費方案每月 100 次，系統最多用 90 次並優先保留每日推播 |
| **不重複推播** | 每則事件有唯一的事件鍵，重試沿用 LINE retry key；排程重跑、系統重啟都不會重複送出 |
| **資料誠實** | 漲跌都來自實際資料；缺前一交易日就寫「暫無有效資料」，過期或模擬資料一律明確標示 |
| **報價狀態** | 依查價時間表判斷是否最新：兩次查價之間顯示「有效」與下次查價時間，只有來源沒更新或排程漏查才標示過期 |
| **管理後台** | 密碼登入；儀表板、歷史資料、推播設定、系統狀態；手機版表格自動改成卡片 |

---

## 運作方式

```mermaid
flowchart LR
    cron["Supabase pg_cron<br/>每 15 分鐘"] -->|CRON_SECRET| api["Vercel 排程 API<br/>東京 hnd1"]
    api -->|"09:00、21:30 才查價"| gold["GoldAPI.io<br/>XAU/USD"]
    api <--> db[("Supabase<br/>快照・事件・額度")]
    api -->|"每日卡片、提醒"| line["LINE Messaging API<br/>群發"]
    line --> friends["好友的 LINE"]
    line -. 抓走勢圖 .-> chart["走勢圖 PNG<br/>/api/chart"]
    chart --> db
    admin["管理後台<br/>密碼登入"] <--> db
```

1. Supabase 的 pg_cron 每 15 分鐘呼叫網站的排程 API。大多數時候還沒到時間，API 直接回「未到期」，不會用掉查價次數。
2. 到了推播或檢查時間，向 GoldAPI 取得 XAU/USD 報價，驗證後存成快照，算出跟前一交易日的漲跌。
3. 組成每日卡片（或提醒），檢查 LINE 剩餘額度夠送給所有人後送出；結果記錄在資料庫，失敗會重試。
4. 卡片裡的走勢圖由網站即時產生，LINE 的伺服器直接來抓。

---

## 技術與費用

| | 使用 | 費用 |
|---|---|---|
| 網站 | Next.js 16（App Router）、TypeScript、Tailwind CSS 4，部署在 Vercel（東京） | Hobby 免費 |
| 資料庫與排程 | Supabase（Postgres、pg_cron、pg_net、Vault，東京） | 免費方案 |
| 行情來源 | GoldAPI.io（XAU/USD 現貨，買賣中價） | 免費方案，每月 100 次 |
| 推播 | LINE Messaging API（官方帳號，Flex Message 卡片） | 輕用量免費，每月 200 則 |
| 走勢圖 | `next/og` 產生 PNG，字型為 Noto Sans TC 子集（SIL OFL） | — |
| 測試 | Vitest，183 個測試；不連真的 LINE、Supabase 或行情來源 | — |

LINE 依收件人數計算額度：2 個人時，每日推播一個月約 42～44 則，就算每天都觸發提醒，最多也約 84～88 則，都在 200 則以內。

---

## 專案結構

```
gold-daily/
├── web/            Next.js 應用程式（說明、環境變數、部署見 web/README.md）
│   ├── src/app/    頁面與 API（排程、走勢圖、webhook）
│   ├── src/lib/    行情來源、排程工作、LINE、資料存取、額度保護
│   └── supabase/   資料表 migration 與 pg_cron 排程 SQL
├── design/         視覺設計稿（純 HTML，直接用瀏覽器開 design/index.html）
└── docs/images/    README 的截圖
```

## 安裝與部署

環境變數、Supabase migration、pg_cron 排程、LINE 官方帳號設定與 Vercel 部署步驟，都在 **[web/README.md](web/README.md)**。
