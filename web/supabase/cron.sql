-- Gold Daily 排程（Supabase pg_cron + pg_net）
-- Vercel Hobby 的 Cron 一天只能跑一次、且只精確到小時，所以每 15 分鐘的盤中檢查與準時的每日推播由這裡觸發。
-- 執行前：
--   1. Database > Extensions 啟用 pg_cron 與 pg_net
--   2. 把下面兩個 <...> 換成實際值（CRON_SECRET 存在 Vault，不寫在排程內容裡）
-- 可重複執行：會先移除同名排程再建立。

-- 1) 把網址與 CRON_SECRET 存進 Vault（只需要做一次；要更換時先刪除舊的 secret）
-- select vault.create_secret('https://<your-app>.vercel.app', 'gold_daily_url');
-- select vault.create_secret('<CRON_SECRET>', 'gold_daily_cron_secret');

-- 2) 共用的呼叫函式
create or replace function public.gold_daily_call(p_path text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'gold_daily_url') || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gold_daily_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000  -- pg_net 預設只有 2 秒，排程工作可能需要更久
  );
$$;

revoke all on function public.gold_daily_call(text) from public, anon, authenticated;

-- 3) 每 15 分鐘呼叫一次。是否真的執行由 API 依設定決定（到了推播時間才推播、依檢查頻率才檢查），
--    所以不用改這裡的排程就能在管理介面調整推播時間與檢查頻率。
select cron.unschedule(jobid) from cron.job where jobname in ('gold-daily-daily', 'gold-daily-intraday', 'gold-daily-quota');

select cron.schedule('gold-daily-daily',    '*/15 * * * *', $$ select public.gold_daily_call('/api/cron/daily') $$);
select cron.schedule('gold-daily-intraday', '*/15 * * * *', $$ select public.gold_daily_call('/api/cron/intraday') $$);
select cron.schedule('gold-daily-quota',    '7 * * * *',    $$ select public.gold_daily_call('/api/cron/quota-sync') $$);

-- 查看執行結果：
-- select * from cron.job_run_details order by start_time desc limit 20;
-- select id, status_code, left(content::text, 200) from net._http_response order by created desc limit 20;
