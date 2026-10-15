import 'server-only';
import { isAuthorizedCronRequest } from '../auth/cron';
import { getEnv } from '../env';
import { buildDeps } from '../server';
import type { JobDeps, JobOutcome } from './deps';

// 排程 API 的共用處理：驗證 CRON_SECRET → 記錄這次呼叫 → 執行工作 → 回傳簡短結果（不含任何秘密或堆疊）。

export function cronHandler(job: 'daily' | 'intraday' | 'quota_sync', run: (deps: JobDeps) => Promise<JobOutcome>) {
  return async function handler(request: Request): Promise<Response> {
    if (!isAuthorizedCronRequest(request, getEnv().CRON_SECRET)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    try {
      const deps = await buildDeps();
      // 排程每 15 分鐘呼叫一次，大多數時候還沒到時間；每次都記錄，系統狀態頁才知道排程有在跑
      await deps.store.recordCronCall(job, deps.now()).catch(() => {});
      const outcome = await run(deps);
      return Response.json(
        { status: outcome.status, detail: outcome.detail },
        { status: outcome.status === 'failed' ? 500 : 200 },
      );
    } catch {
      return Response.json({ status: 'failed', detail: '排程執行失敗，請查看系統狀態頁' }, { status: 500 });
    }
  };
}
