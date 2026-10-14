-- Gold Daily 初始 schema
-- 可重複執行（if not exists / or replace）。請在 Supabase SQL Editor 執行，或用 supabase db push。
-- 所有時間欄位都是 timestamptz（以 UTC 儲存），畫面再轉台北時間。
-- 只有伺服器端用 service_role 存取；所有資料表開 RLS 且不開放任何 policy，anon / authenticated 無法讀寫。

-- ---------------------------------------------------------------------------
-- 1. 行情快照
-- ---------------------------------------------------------------------------
create table if not exists public.gold_price_snapshots (
  id               bigint generated always as identity primary key,
  symbol           text        not null,
  price            numeric(14, 4) not null check (price > 0),
  currency         text        not null,
  unit             text        not null check (unit in ('troy_oz', 'gram')),
  source           text        not null,
  quote_timestamp  timestamptz not null,
  fetched_at       timestamptz not null,
  is_delayed       boolean,                       -- null = 供應商未提供
  status           text        not null check (status in ('valid', 'delayed', 'mock')),
  daily_date       date,                          -- 這筆是某個台北日期的「每日快照」時才填
  created_at       timestamptz not null default now(),
  -- 同一來源、同一商品、同一報價時間只存一筆（排程重跑不會重複寫入）
  constraint gold_price_snapshots_quote_unique unique (source, symbol, quote_timestamp)
);

-- 每個來源＋商品每天最多一筆每日快照
create unique index if not exists gold_price_snapshots_daily_unique
  on public.gold_price_snapshots (source, symbol, daily_date)
  where daily_date is not null;

create index if not exists gold_price_snapshots_symbol_ts_idx
  on public.gold_price_snapshots (source, symbol, quote_timestamp desc);

-- ---------------------------------------------------------------------------
-- 2. 推播與提醒設定（單列表，id 固定為 1）
-- ---------------------------------------------------------------------------
create table if not exists public.notification_settings (
  id                        smallint primary key default 1 check (id = 1),
  daily_enabled             boolean     not null default true,
  daily_push_time           time        not null default '09:00',
  alert_enabled             boolean     not null default true,
  rise_threshold_percent    numeric(6, 3) not null default 1 check (rise_threshold_percent > 0 and rise_threshold_percent <= 20),
  fall_threshold_percent    numeric(6, 3) not null default 1 check (fall_threshold_percent > 0 and fall_threshold_percent <= 20),
  polling_interval_minutes  integer     not null default 15 check (polling_interval_minutes in (0, 15, 30, 60)), -- 0 = 不做盤中檢查
  cooldown_minutes          integer     not null default 240 check (cooldown_minutes between 15 and 1440),
  baseline_mode             text        not null default 'first_valid_of_day'
                              check (baseline_mode in ('first_valid_of_day', 'previous_close', 'manual')),
  baseline_price            numeric(14, 4) check (baseline_price is null or baseline_price > 0),
  baseline_timestamp        timestamptz,
  baseline_date             date,                 -- 基準適用的台北日期（手動模式為 null）
  timezone                  text        not null default 'Asia/Taipei',
  -- 以下為額度與測試用欄位（README 有說明）
  line_plan                 text        not null default 'light_free',
  monthly_message_quota     integer     not null default 200 check (monthly_message_quota > 0),
  quota_safety_buffer       integer     not null default 5 check (quota_safety_buffer between 0 and 100),
  mock_scenario             text        not null default 'normal'
                              check (mock_scenario in ('normal', 'surge', 'plunge', 'stale', 'error')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

insert into public.notification_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. 通知事件（觸發、發送、重試紀錄）
-- ---------------------------------------------------------------------------
create table if not exists public.notification_events (
  id                 bigint generated always as identity primary key,
  event_type         text        not null check (event_type in ('daily', 'alert_up', 'alert_down', 'test')),
  symbol             text,
  current_price      numeric(14, 4),
  baseline_price     numeric(14, 4),
  change_percent     numeric(10, 4),
  threshold_percent  numeric(6, 3),
  source_timestamp   timestamptz,
  idempotency_key    text        not null,
  line_retry_key     uuid        not null default gen_random_uuid(), -- 重試時沿用，讓 LINE 端去重
  message_text       text,
  status             text        not null default 'pending'
                       check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  skip_reason        text,
  attempt_count      integer     not null default 0,
  last_error         text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint notification_events_idempotency_unique unique (idempotency_key)
);

create index if not exists notification_events_type_created_idx
  on public.notification_events (event_type, created_at desc);
create index if not exists notification_events_sent_idx
  on public.notification_events (sent_at) where status = 'sent';

-- ---------------------------------------------------------------------------
-- 4. 排程執行紀錄
-- ---------------------------------------------------------------------------
create table if not exists public.job_runs (
  id                 bigint generated always as identity primary key,
  job_type           text        not null check (job_type in ('daily', 'intraday', 'quota_sync')),
  trigger            text        not null default 'cron' check (trigger in ('cron', 'manual')),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text        not null default 'running'
                       check (status in ('running', 'success', 'skipped', 'failed')),
  records_processed  integer     not null default 0,
  error_message      text,
  detail             text,
  created_at         timestamptz not null default now()
);

create index if not exists job_runs_type_started_idx on public.job_runs (job_type, started_at desc);

-- ---------------------------------------------------------------------------
-- 5. 排程鎖（同一種工作同時只跑一個；也記錄排程最後一次被呼叫的時間）
-- ---------------------------------------------------------------------------
create table if not exists public.job_locks (
  job_type        text primary key,
  locked_until    timestamptz not null,
  owner           uuid        not null,
  last_called_at  timestamptz
);

create or replace function public.try_acquire_job_lock(p_job text, p_owner uuid, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.job_locks (job_type, locked_until, owner, last_called_at)
  values (p_job, now() + make_interval(secs => p_ttl_seconds), p_owner, now())
  on conflict (job_type) do update
    set locked_until = excluded.locked_until,
        owner = excluded.owner,
        last_called_at = now()
    where public.job_locks.locked_until < now();
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    update public.job_locks set last_called_at = now() where job_type = p_job;
  end if;
  return v_rows > 0;
end;
$$;

create or replace function public.release_job_lock(p_job text, p_owner uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.job_locks set locked_until = now() where job_type = p_job and owner = p_owner;
$$;

-- ---------------------------------------------------------------------------
-- 6. LINE 訊息用量同步紀錄（每月用量以官方查詢為準，本地只做保守估算）
-- ---------------------------------------------------------------------------
create table if not exists public.line_quota_syncs (
  id             bigint generated always as identity primary key,
  synced_at      timestamptz not null default now(),
  success        boolean     not null,
  quota_type     text        check (quota_type in ('none', 'limited')),
  quota_value    integer,
  total_usage    integer,
  error_message  text
);

create index if not exists line_quota_syncs_synced_idx on public.line_quota_syncs (synced_at desc);

-- ---------------------------------------------------------------------------
-- 權限：開 RLS、不建 policy；函式只給 service_role 執行
-- ---------------------------------------------------------------------------
alter table public.gold_price_snapshots  enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notification_events   enable row level security;
alter table public.job_runs              enable row level security;
alter table public.job_locks             enable row level security;
alter table public.line_quota_syncs      enable row level security;

revoke all on function public.try_acquire_job_lock(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_job_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.try_acquire_job_lock(text, uuid, integer) to service_role;
grant execute on function public.release_job_lock(text, uuid) to service_role;
