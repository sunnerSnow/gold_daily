-- Gold Daily 第 3 版：Telegram 推播
-- 可重複執行。請在前兩份 migration 之後、設定 TELEGRAM_BOT_TOKEN 之前執行。
--
-- 每則通知事件同時送 LINE 與 Telegram，兩邊分開記錄：原本的 status、attempt_count 等欄位是 LINE 的，
-- 這裡新增 Telegram 自己的一組。Telegram 沒有 LINE 的 retry key，所以記下已送達的 chat ID，
-- 重試時只送還沒收到的聊天室，避免重複推播。

alter table public.notification_events
  add column if not exists telegram_status        text,              -- null = 沒有送 Telegram（尚未設定，或不用發送）
  add column if not exists telegram_sent_to       text[] not null default '{}',
  add column if not exists telegram_attempt_count integer not null default 0,
  add column if not exists telegram_last_error    text,
  add column if not exists telegram_sent_at       timestamptz;

alter table public.notification_events drop constraint if exists notification_events_telegram_status_check;
alter table public.notification_events
  add constraint notification_events_telegram_status_check
  check (telegram_status is null or telegram_status in ('sending', 'sent', 'failed'));
