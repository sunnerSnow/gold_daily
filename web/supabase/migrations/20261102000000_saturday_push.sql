-- Gold Daily 第 5 版：週六推播
-- 可重複執行。請在 20261023000000_telegram_subscribers.sql 之後執行。
--
-- 國際金價在台北時間週六清晨收盤，週五晚上美國盤的走勢要到週六早上才看得到。
-- skip_weekends（週末不推播）開啟時，saturday_push = true 仍會在週六送每日推播（當週收盤價），週日照樣不推。
-- 只影響每日推播；盤中檢查週末一律不查。

alter table public.notification_settings
  add column if not exists saturday_push boolean not null default true;
