import { runIntradayJob } from '@/lib/jobs/intraday';
import { cronHandler } from '@/lib/jobs/cron-route';

// 盤中異動檢查。依設定的檢查頻率決定要不要真的執行。
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = cronHandler((deps) => runIntradayJob(deps, { trigger: 'cron' }));
export const GET = handler;
export const POST = handler;
