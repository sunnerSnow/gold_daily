-- Gold Daily 第 2 版：固定時間查價、週末不推播、到價提醒、行情 API 查價次數紀錄
-- 可重複執行。請在 init migration 之後執行。

-- ---------------------------------------------------------------------------
-- 1. 盤中檢查改成三種模式：固定時間（times）、固定間隔（interval）、不檢查（off）
-- ---------------------------------------------------------------------------
alter table public.notification_settings
  add column if not exists intraday_mode text not null default 'times',
  add column if not exists check_times text not null default '21:30',   -- 逗號分隔的 HH:MM（台北）
  add column if not exists skip_weekends boolean not null default true;

alter table public.notification_settings drop constraint if exists notification_settings_intraday_mode_check;
alter table public.notification_settings
  add constraint notification_settings_intraday_mode_check check (intraday_mode in ('times', 'interval', 'off'));

alter table public.notification_settings drop constraint if exists notification_settings_check_times_check;
alter table public.notification_settings
  add constraint notification_settings_check_times_check
  check (check_times ~ '^(([01][0-9]|2[0-3]):[0-5][0-9])?(,([01][0-9]|2[0-3]):[0-5][0-9])*$');

-- ---------------------------------------------------------------------------
-- 2. 通知事件新增「到價提醒」類型
-- ---------------------------------------------------------------------------
alter table public.notification_events drop constraint if exists notification_events_event_type_check;
alter table public.notification_events
  add constraint notification_events_event_type_check
  check (event_type in ('daily', 'alert_up', 'alert_down', 'target', 'test'));

-- ---------------------------------------------------------------------------
-- 3. 到價提醒（觸發一次就自動關閉）
-- ---------------------------------------------------------------------------
create table if not exists public.price_targets (
  id                  bigint generated always as identity primary key,
  direction           text        not null check (direction in ('above', 'below')),
  target_price        numeric(14, 4) not null check (target_price > 0),
  -- 綁定建立時的行情商品，不同來源、幣別或單位的價格不會互相比較
  source              text        not null,
  symbol              text        not null,
  currency            text        not null,
  unit                text        not null check (unit in ('troy_oz', 'gram')),
  status              text        not null default 'active' check (status in ('active', 'triggered', 'cancelled')),
  note                text,
  created_at          timestamptz not null default now(),
  triggered_at        timestamptz,
  triggered_price     numeric(14, 4),
  triggered_quote_at  timestamptz,
  event_id            bigint references public.notification_events (id) on delete set null
);

create index if not exists price_targets_status_idx on public.price_targets (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. 行情 API 查價紀錄（免費方案有每月次數上限，每次呼叫前先記一筆）
-- ---------------------------------------------------------------------------
create table if not exists public.provider_calls (
  id          bigint generated always as identity primary key,
  provider    text        not null,
  endpoint    text        not null,               -- latest / history / stat
  purpose     text        not null,               -- daily / check / manual / backfill / reference / stat
  called_at   timestamptz not null default now(),
  success     boolean,
  error       text
);

create index if not exists provider_calls_provider_called_idx on public.provider_calls (provider, called_at desc);

alter table public.price_targets  enable row level security;
alter table public.provider_calls enable row level security;
