import { formatTestMessage } from '../line/messages';
import { computeQuotaState, type MessageKind, type QuotaState } from '../quota/guard';
import type { EventRow, QuotaSyncRow, SettingsRow, SkipReason } from '../store/types';
import { startOfLineBillingMonth } from '../time';
import { safeErrorMessage, type JobDeps } from './deps';

// 發送 LINE 訊息：額度檢查 → 發送 → 記錄結果。重試沿用同一個 retry key，避免重複推播。

/** 單次執行內最多嘗試幾次（含第一次） */
export const ATTEMPTS_PER_RUN = 3;
/** 一則事件累計最多嘗試幾次（含手動重試） */
export const MAX_TOTAL_ATTEMPTS = 6;
/** 超過這個時間不再重試（LINE retry key 的去重期限） */
export const RETRY_WINDOW_MS = 24 * 3600_000;
/** 發送前若官方用量超過這個時間沒同步，就先同步一次 */
const REFRESH_QUOTA_AFTER_MS = 10 * 60_000;
const BACKOFF_MS = [1000, 3000];

/** 這些原因造成的略過，之後條件改善時可以再送 */
export const RECOVERABLE_SKIPS: SkipReason[] = ['line_not_configured', 'quota_unverified', 'quota_insufficient'];

export async function syncQuota(deps: JobDeps): Promise<QuotaSyncRow | null> {
  if (!deps.line.configured) return null;
  const syncedAt = deps.now();
  try {
    const [quota, consumption] = await Promise.all([deps.line.getQuota(), deps.line.getConsumption()]);
    return await deps.store.insertQuotaSync({
      syncedAt,
      success: true,
      quotaType: quota.type,
      quotaValue: quota.value,
      totalUsage: consumption.totalUsage,
      errorMessage: null,
    });
  } catch (err) {
    return await deps.store.insertQuotaSync({
      syncedAt,
      success: false,
      quotaType: null,
      quotaValue: null,
      totalUsage: null,
      errorMessage: safeErrorMessage(err),
    });
  }
}

export async function getQuotaState(
  deps: JobDeps,
  settings: SettingsRow,
  options: { refresh: boolean },
): Promise<QuotaState> {
  const now = deps.now();
  let latest = await deps.store.getLatestQuotaSync({ successOnly: true });
  if (options.refresh && deps.line.configured && (!latest || now.getTime() - latest.syncedAt.getTime() > REFRESH_QUOTA_AFTER_MS)) {
    const synced = await syncQuota(deps);
    if (synced?.success) latest = synced;
  }
  const localSentThisMonth = await deps.store.countSentSince(startOfLineBillingMonth(now));
  return computeQuotaState({
    now,
    latestSuccessfulSync: latest,
    localSentThisMonth,
    monthlyMessageQuota: settings.monthlyMessageQuota,
    quotaSafetyBuffer: settings.quotaSafetyBuffer,
    dailyEnabled: settings.dailyEnabled,
  });
}

/**
 * 發送一則事件。已送出的不會再送；LINE 未連線或額度不足時記錄為略過，不假裝送出。
 */
export async function deliverEvent(deps: JobDeps, event: EventRow, kind: MessageKind, settings: SettingsRow): Promise<EventRow> {
  if (event.status === 'sent') return event;
  if (!event.messageText) {
    return deps.store.updateEvent(event.id, { status: 'failed', lastError: '沒有訊息內容' });
  }
  if (!deps.line.configured) {
    return deps.store.updateEvent(event.id, { status: 'skipped', skipReason: 'line_not_configured' });
  }

  const quota = await getQuotaState(deps, settings, { refresh: true });
  if (!quota.verified) {
    return deps.store.updateEvent(event.id, { status: 'skipped', skipReason: 'quota_unverified', lastError: quota.pausedReason });
  }
  if (!quota.canSend[kind]) {
    return deps.store.updateEvent(event.id, { status: 'skipped', skipReason: 'quota_insufficient', lastError: quota.pausedReason });
  }

  let attempts = event.attemptCount;
  let current = await deps.store.updateEvent(event.id, { status: 'sending', skipReason: null });
  for (let i = 0; i < ATTEMPTS_PER_RUN && attempts < MAX_TOTAL_ATTEMPTS; i++) {
    attempts += 1;
    const result = await deps.line.pushText(event.messageText, event.lineRetryKey);
    if (result.ok) {
      return deps.store.updateEvent(event.id, { status: 'sent', attemptCount: attempts, sentAt: deps.now(), lastError: null });
    }
    current = await deps.store.updateEvent(event.id, { status: 'sending', attemptCount: attempts, lastError: result.error });
    if (!result.retryable) break;
    if (i < ATTEMPTS_PER_RUN - 1 && attempts < MAX_TOTAL_ATTEMPTS) await deps.sleep(BACKOFF_MS[i] ?? 3000);
  }
  return deps.store.updateEvent(current.id, { status: 'failed', attemptCount: attempts });
}

export type RetryResult = { ok: true; event: EventRow } | { ok: false; reason: string };

/** 手動重試失敗或可恢復的事件 */
export async function retryEvent(deps: JobDeps, eventId: number): Promise<RetryResult> {
  const event = await deps.store.getEvent(eventId);
  if (!event) return { ok: false, reason: '找不到這筆事件' };
  if (event.status === 'sent') return { ok: false, reason: '這則訊息已經送出' };
  const recoverable = event.status === 'failed' || (event.status === 'skipped' && event.skipReason && RECOVERABLE_SKIPS.includes(event.skipReason));
  if (!recoverable) return { ok: false, reason: '這筆事件不能重試' };
  if (deps.now().getTime() - event.createdAt.getTime() > RETRY_WINDOW_MS) {
    return { ok: false, reason: '已超過 24 小時，為避免重複推播不再重試' };
  }
  if (event.attemptCount >= MAX_TOTAL_ATTEMPTS) return { ok: false, reason: `已達重試上限（${MAX_TOTAL_ATTEMPTS} 次）` };
  const settings = await deps.store.getSettings();
  const kind: MessageKind = event.eventType === 'daily' ? 'daily' : event.eventType === 'test' ? 'test' : 'alert';
  return { ok: true, event: await deliverEvent(deps, event, kind, settings) };
}

/** 管理介面的測試推播：每按一次是一個新事件 */
export async function sendTestPush(deps: JobDeps): Promise<EventRow> {
  const settings = await deps.store.getSettings();
  const now = deps.now();
  const { event } = await deps.store.insertEvent({
    eventType: 'test',
    idempotencyKey: `test:${deps.newId()}`,
    messageText: formatTestMessage(now),
  });
  return deliverEvent(deps, event, 'test', settings);
}
