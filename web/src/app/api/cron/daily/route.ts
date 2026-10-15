import { runDailyJob } from '@/lib/jobs/daily';
import { cronHandler } from '@/lib/jobs/cron-route';

// 每日行情與推播。可以每 15 分鐘呼叫；還沒到設定的推播時間或今天已推播時會直接回 not_due。
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = cronHandler('daily', (deps) => runDailyJob(deps, { trigger: 'cron' }));
export const GET = handler;
export const POST = handler;
