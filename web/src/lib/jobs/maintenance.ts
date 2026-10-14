import type { JobTrigger } from '../store/types';
import { taipeiDate } from '../time';
import { safeErrorMessage, type JobDeps, type JobOutcome } from './deps';
import { syncQuota } from './notify';
import { getProviderBudget, meteredCall } from './provider-usage';
import { instrumentOf } from './snapshot';

// 額度同步與歷史回填。

export async function runQuotaSyncJob(deps: JobDeps, options: { trigger: JobTrigger }): Promise<JobOutcome> {
  if (!deps.line.configured) return { status: 'disabled', detail: 'LINE 尚未連線，無法同步額度' };
  const owner = deps.newId();
  if (!(await deps.store.tryAcquireLock('quota_sync', owner, 60))) {
    return { status: 'locked', detail: '另一個額度同步正在執行' };
  }
  const run = await deps.store.startJobRun('quota_sync', options.trigger);
  try {
    const sync = await syncQuota(deps);
    if (!sync?.success) {
      const message = sync?.errorMessage ?? '同步失敗';
      await deps.store.finishJobRun(run.id, { status: 'failed', errorMessage: message });
      return { status: 'failed', detail: message, jobRunId: run.id };
    }
    const limit = sync.quotaType === 'limited' ? `${sync.quotaValue} 則` : '無上限';
    const detail = `官方用量 ${sync.totalUsage} 則（上限 ${limit}）`;
    await deps.store.finishJobRun(run.id, { status: 'success', recordsProcessed: 1, detail });
    return { status: 'success', detail, jobRunId: run.id };
  } catch (err) {
    const message = safeErrorMessage(err);
    await deps.store.finishJobRun(run.id, { status: 'failed', errorMessage: message });
    return { status: 'failed', detail: message, jobRunId: run.id };
  } finally {
    await deps.store.releaseLock('quota_sync', owner);
  }
}

/**
 * 用行情來源的歷史資料補每日快照（不覆蓋已存在的日期）。回傳新寫入的天數。
 * 有每月次數上限的來源只呼叫一次歷史端點（GoldAPI 一次最多 90 天），而且要有扣掉每日推播後的餘額。
 */
export async function backfillHistory(deps: JobDeps, days: number): Promise<{ inserted: number; message: string }> {
  const status = deps.provider.getProviderStatus();
  if (!status.configured || !status.instrument) return { inserted: 0, message: '尚未設定行情來源' };
  const now = deps.now();
  const today = taipeiDate(now);
  if (status.monthlyCallQuota !== null) {
    const budget = await getProviderBudget(deps, await deps.store.getSettings());
    if (!budget.canExtra) return { inserted: 0, message: budget.reason ?? '查價次數不足，無法回填' };
  }
  try {
    const bars = await meteredCall(deps, 'history', 'backfill', () =>
      deps.provider.getHistoricalPrice({ from: new Date(now.getTime() - days * 86_400_000), to: now }),
    );
    const instrument = instrumentOf({ ...status.instrument, source: deps.provider.id });
    let inserted = 0;
    for (const bar of bars) {
      if (bar.date >= today) continue; // 今天由每日排程負責
      if (await deps.store.getDailySnapshot(instrument, bar.date)) continue;
      const { snapshot } = await deps.store.insertSnapshot({
        ...instrument,
        price: bar.price,
        quoteTimestamp: bar.timestamp,
        fetchedAt: now,
        isDelayed: null,
        status: status.isMock ? 'mock' : 'valid',
      });
      if (await deps.store.markDailySnapshot(snapshot.id, bar.date)) inserted += 1;
    }
    return { inserted, message: `補上 ${inserted} 天的每日快照` };
  } catch (err) {
    return { inserted: 0, message: safeErrorMessage(err) };
  }
}
