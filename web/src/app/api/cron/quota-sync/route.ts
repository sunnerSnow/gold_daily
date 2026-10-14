import { runQuotaSyncJob } from '@/lib/jobs/maintenance';
import { cronHandler } from '@/lib/jobs/cron-route';

// 同步 LINE 官方訊息用量（發送前也會自動同步，這支讓畫面上的數字保持新鮮）。
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const handler = cronHandler((deps) => runQuotaSyncJob(deps, { trigger: 'cron' }));
export const GET = handler;
export const POST = handler;
