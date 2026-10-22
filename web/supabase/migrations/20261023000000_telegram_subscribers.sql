-- Gold Daily 第 4 版：Telegram 訂閱者
-- 可重複執行。請在 20261022000000_telegram.sql 之後執行。
--
-- 任何人對 bot 按「開始」（/start）就訂閱、傳 /stop 取消；封鎖 bot 會自動標成 blocked。
-- 每日推播與提醒送給 TELEGRAM_CHAT_ID（固定名單）＋這裡 status = active 的人；測試推播只送固定名單。
-- 只存後台顯示用的名字與 @username，不存電話或訊息內容。

create table if not exists public.telegram_subscribers (
  chat_id        text        primary key,
  name           text,
  username       text,
  status         text        not null default 'active' check (status in ('active', 'stopped', 'blocked')),
  subscribed_at  timestamptz not null default now(),   -- 最近一次訂閱（取消後重新訂閱會更新）
  updated_at     timestamptz not null default now()
);

create index if not exists telegram_subscribers_status_idx
  on public.telegram_subscribers (status, subscribed_at desc);

alter table public.telegram_subscribers enable row level security;
