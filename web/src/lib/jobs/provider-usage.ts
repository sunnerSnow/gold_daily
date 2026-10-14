import { computeProviderBudget, remainingDailyRuns, startOfUtcMonth, type ProviderBudget } from '../gold/budget';
import type { ProviderCallEndpoint, ProviderCallPurpose, SettingsRow } from '../store/types';
import { startOfTaipeiDay } from '../time';
import { safeErrorMessage, type JobDeps } from './deps';

// 行情 API 的查價次數：每次呼叫前先記一筆（失敗也算，因為供應商端可能已經計次）。

export async function getProviderBudget(
  deps: JobDeps,
  settings: Pick<SettingsRow, 'dailyEnabled' | 'skipWeekends'>,
): Promise<ProviderBudget> {
  const status = deps.provider.getProviderStatus();
  const now = deps.now();
  if (status.monthlyCallQuota === null) {
    return computeProviderBudget({ monthlyQuota: null, used: 0, remainingDailyRuns: 0 });
  }
  const [used, lastDaily] = await Promise.all([
    deps.store.countProviderCalls(deps.provider.id, startOfUtcMonth(now)),
    deps.store.getLastJobRun('daily', ['success', 'skipped', 'failed']),
  ]);
  const dailyDoneToday = Boolean(lastDaily && lastDaily.startedAt >= startOfTaipeiDay(now));
  return computeProviderBudget({
    monthlyQuota: status.monthlyCallQuota,
    used,
    remainingDailyRuns: remainingDailyRuns(now, {
      dailyEnabled: settings.dailyEnabled,
      skipWeekends: settings.skipWeekends,
      dailyDoneToday,
    }),
  });
}

/** 呼叫行情 API 並記錄次數；沒有上限的來源（Mock）不記 */
export async function meteredCall<T>(
  deps: JobDeps,
  endpoint: ProviderCallEndpoint,
  purpose: ProviderCallPurpose,
  fn: () => Promise<T>,
): Promise<T> {
  if (deps.provider.getProviderStatus().monthlyCallQuota === null) return fn();
  const id = await deps.store.recordProviderCall({ provider: deps.provider.id, endpoint, purpose, calledAt: deps.now() });
  try {
    const result = await fn();
    await deps.store.finishProviderCall(id, { success: true, error: null });
    return result;
  } catch (err) {
    await deps.store.finishProviderCall(id, { success: false, error: safeErrorMessage(err) });
    throw err;
  }
}
