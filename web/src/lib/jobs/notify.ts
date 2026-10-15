import { chartImageUrl } from '../chart/daily-chart';
import { formatTestMessage } from '../line/messages';
import { computeQuotaState, type MessageKind, type QuotaState } from '../quota/guard';
import type { EventRow, QuotaSyncRow, SettingsRow, SkipReason } from '../store/types';
import { startOfLineBillingMonth } from '../time';
import { dailyChartUrl, latestDailyPreview } from './chart-data';
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
/** 圖片被 LINE 拒絕、改送純文字時記在事件上，畫面與排程紀錄才知道少了圖 */
export const CHART_DROPPED_NOTE = '走勢圖被 LINE 拒絕，只送出文字';

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

export interface DeliverOptions {
  /** 跟文字同一次請求送出的圖片（LINE 只算 1 則） */
  imageUrl?: string | null;
}

/**
 * 發送一則事件。已送出的不會再送；LINE 未連線或額度不足時記錄為略過，不假裝送出。
 */
export async function deliverEvent(
  deps: JobDeps,
  event: EventRow,
  kind: MessageKind,
  settings: SettingsRow,
  options: DeliverOptions = {},
): Promise<EventRow> {
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
  let imageUrl = options.imageUrl ?? null;
  let current = await deps.store.updateEvent(event.id, { status: 'sending', skipReason: null });
  for (let i = 0; i < ATTEMPTS_PER_RUN && attempts < MAX_TOTAL_ATTEMPTS; i++) {
    attempts += 1;
    let result = await deps.line.push({ text: event.messageText, imageUrl }, event.lineRetryKey);
    // LINE 拒絕圖片（400）時改送純文字：圖片只是附加內容，不能擋住推播。
    // 被拒絕的請求不算被接受，沿用同一個 retry key 不會造成重複。
    if (!result.ok && imageUrl && result.status === 400) {
      imageUrl = null;
      result = await deps.line.push({ text: event.messageText }, event.lineRetryKey);
    }
    if (result.ok) {
      const dropped = Boolean(options.imageUrl) && !imageUrl;
      return deps.store.updateEvent(event.id, { status: 'sent', attemptCount: attempts, sentAt: deps.now(), lastError: dropped ? CHART_DROPPED_NOTE : null });
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
  // 每日推播重試時一樣附上當天的走勢圖（日期取自事件鍵 daily:YYYY-MM-DD）
  const dailyDate = event.eventType === 'daily' ? /^daily:(\d{4}-\d{2}-\d{2})$/.exec(event.idempotencyKey)?.[1] : undefined;
  const imageUrl = dailyDate ? await dailyChartUrl(deps, dailyDate) : null;
  return { ok: true, event: await deliverEvent(deps, event, kind, settings, { imageUrl }) };
}

/** 管理介面的測試推播：每按一次是一個新事件。附上每日行情的格式預覽與走勢圖，方便確認實際樣子。 */
export async function sendTestPush(deps: JobDeps): Promise<{ event: EventRow; withChart: boolean }> {
  const settings = await deps.store.getSettings();
  const now = deps.now();
  const preview = await latestDailyPreview(deps).catch(() => null);
  const imageUrl = preview?.chartAvailable ? chartImageUrl(deps.appUrl, preview.date) : null;
  const { event } = await deps.store.insertEvent({
    eventType: 'test',
    idempotencyKey: `test:${deps.newId()}`,
    messageText: formatTestMessage(now, preview?.text ?? null),
  });
  const delivered = await deliverEvent(deps, event, 'test', settings, { imageUrl });
  return { event: delivered, withChart: imageUrl !== null && delivered.lastError !== CHART_DROPPED_NOTE };
}
