import { textMessage, type LineMessage } from '../line/client';
import { formatTestMessage } from '../line/messages';
import { computeQuotaState, type MessageKind, type QuotaState } from '../quota/guard';
import type { EventRow, QuotaSyncRow, SettingsRow, SkipReason } from '../store/types';
import { chatLabel, type TelegramMessage } from '../telegram/client';
import { buildTestTelegram, telegramText } from '../telegram/format';
import { startOfLineBillingMonth } from '../time';
import { dailyMessages, latestDailyPreview } from './chart-data';
import { safeErrorMessage, type JobDeps } from './deps';

// 發送訊息：LINE 與 Telegram 各自發送、各自記錄，一邊沒送到不影響另一邊。
// LINE：額度檢查 → 發送 → 記錄結果。重試沿用同一個 retry key，避免重複推播。
// Telegram：沒有額度限制，也沒有 retry key；記下已送達的聊天室，重試只送還沒收到的。

/** 單次執行內最多嘗試幾次（含第一次） */
export const ATTEMPTS_PER_RUN = 3;
/** 一則事件累計最多嘗試幾次（含手動重試）；LINE 與 Telegram 分開計算 */
export const MAX_TOTAL_ATTEMPTS = 6;
/** 超過這個時間不再重試（LINE retry key 的去重期限） */
export const RETRY_WINDOW_MS = 24 * 3600_000;
/** 發送前若官方用量超過這個時間沒同步，就先同步一次 */
const REFRESH_QUOTA_AFTER_MS = 10 * 60_000;
const BACKOFF_MS = [1000, 3000];
/** 卡片被 LINE 拒絕、改送純文字時記在事件上，畫面與排程紀錄才知道 */
export const CARD_DROPPED_NOTE = '卡片被 LINE 拒絕，改送純文字';
/** 走勢圖被 Telegram 拒絕（例如抓不到圖）、改送文字時記在事件上 */
export const PHOTO_DROPPED_NOTE = '走勢圖被 Telegram 拒絕，改送文字';

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
  // 本地只記錄「送出幾次」，每次送給所有推播對象，所以乘上人數（名單中途變多時會高估，只會更保守）
  const recipients = Math.max(1, await deps.line.getRecipientCount());
  const localSentThisMonth = (await deps.store.countSentSince(startOfLineBillingMonth(now))) * recipients;
  return computeQuotaState({
    now,
    latestSuccessfulSync: latest,
    localSentThisMonth,
    monthlyMessageQuota: settings.monthlyMessageQuota,
    quotaSafetyBuffer: settings.quotaSafetyBuffer,
    dailyEnabled: settings.dailyEnabled,
    recipients,
  });
}

export interface DeliverOptions {
  /** 要送出的訊息框（例如每日卡片）；沒給時送事件的純文字。同一次請求對每位收件人只算 1 則 */
  messages?: LineMessage[] | null;
  /** Telegram 要送出的訊息（例如每日走勢圖＋說明）；沒給時送事件的純文字 */
  telegram?: TelegramMessage | null;
}

/**
 * 發送一則事件到 LINE 與 Telegram（有設定的才送）。已送出的那一邊不會再送；
 * LINE 未連線或額度不足時記錄為略過，不假裝送出。
 */
export async function deliverEvent(
  deps: JobDeps,
  event: EventRow,
  kind: MessageKind,
  settings: SettingsRow,
  options: DeliverOptions = {},
): Promise<EventRow> {
  const afterLine = await deliverLine(deps, event, kind, settings, options.messages);
  return deliverTelegram(deps, afterLine, options.telegram);
}

async function deliverLine(
  deps: JobDeps,
  event: EventRow,
  kind: MessageKind,
  settings: SettingsRow,
  rich: LineMessage[] | null | undefined,
): Promise<EventRow> {
  if (event.status === 'sent') return event;
  if (event.status === 'failed' && event.attemptCount >= MAX_TOTAL_ATTEMPTS) return event;
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
  const plain = [textMessage(event.messageText)];
  let messages = rich?.length ? rich : plain;
  let current = await deps.store.updateEvent(event.id, { status: 'sending', skipReason: null });
  for (let i = 0; i < ATTEMPTS_PER_RUN && attempts < MAX_TOTAL_ATTEMPTS; i++) {
    attempts += 1;
    let result = await deps.line.push(messages, event.lineRetryKey);
    // LINE 拒絕卡片（400）時改送純文字：樣式不能擋住推播。
    // 被拒絕的請求不算被接受，沿用同一個 retry key 不會造成重複。
    if (!result.ok && messages !== plain && result.status === 400) {
      messages = plain;
      result = await deps.line.push(messages, event.lineRetryKey);
    }
    if (result.ok) {
      const dropped = Boolean(rich?.length) && messages === plain;
      return deps.store.updateEvent(event.id, { status: 'sent', attemptCount: attempts, sentAt: deps.now(), lastError: dropped ? CARD_DROPPED_NOTE : null });
    }
    current = await deps.store.updateEvent(event.id, { status: 'sending', attemptCount: attempts, lastError: result.error });
    if (!result.retryable) break;
    if (i < ATTEMPTS_PER_RUN - 1 && attempts < MAX_TOTAL_ATTEMPTS) await deps.sleep(BACKOFF_MS[i] ?? 3000);
  }
  return deps.store.updateEvent(current.id, { status: 'failed', attemptCount: attempts });
}

async function deliverTelegram(deps: JobDeps, event: EventRow, rich: TelegramMessage | null | undefined): Promise<EventRow> {
  const tg = deps.telegram;
  if (!tg.configured || !event.messageText || event.telegramStatus === 'sent') return event;
  if (event.telegramAttemptCount >= MAX_TOTAL_ATTEMPTS) return event;

  let message = rich ?? telegramText(event.messageText);
  const sentTo = new Set(event.telegramSentTo);
  let attempts = event.telegramAttemptCount;
  let current = await deps.store.updateEvent(event.id, { telegramStatus: 'sending' });
  for (let i = 0; i < ATTEMPTS_PER_RUN && attempts < MAX_TOTAL_ATTEMPTS; i++) {
    attempts += 1;
    const errors: string[] = [];
    let retryable = false;
    for (const chatId of tg.chatIds.filter((id) => !sentTo.has(id))) {
      let result = await tg.send(chatId, message);
      // 圖片被拒（例如 Telegram 抓不到走勢圖、說明太長）時改送同樣的說明文字；之後的聊天室也直接送文字
      if (!result.ok && message.type === 'photo' && result.status === 400) {
        message = { type: 'text', html: message.caption };
        result = await tg.send(chatId, message);
      }
      if (result.ok) {
        sentTo.add(chatId);
      } else {
        errors.push(tg.chatIds.length > 1 ? `${chatLabel(chatId)}：${result.error}` : result.error);
        retryable ||= result.retryable;
      }
    }
    if (errors.length === 0) {
      const dropped = rich?.type === 'photo' && message.type === 'text';
      return deps.store.updateEvent(event.id, {
        telegramStatus: 'sent',
        telegramSentTo: [...sentTo],
        telegramAttemptCount: attempts,
        telegramSentAt: deps.now(),
        telegramLastError: dropped ? PHOTO_DROPPED_NOTE : null,
      });
    }
    current = await deps.store.updateEvent(event.id, { telegramSentTo: [...sentTo], telegramAttemptCount: attempts, telegramLastError: errors.join('；') });
    if (!retryable) break;
    if (i < ATTEMPTS_PER_RUN - 1 && attempts < MAX_TOTAL_ATTEMPTS) await deps.sleep(BACKOFF_MS[i] ?? 3000);
  }
  return deps.store.updateEvent(current.id, { telegramStatus: 'failed', telegramAttemptCount: attempts });
}

/** 發送失敗的原因（排程紀錄用）；LINE 與 Telegram 都沒失敗時回傳 null。略過（例如額度不足）不算失敗 */
export function deliveryFailure(event: EventRow): string | null {
  if (event.status === 'failed') return event.lastError ?? 'LINE 發送失敗';
  if (event.telegramStatus === 'failed') return `Telegram：${event.telegramLastError ?? '發送失敗'}`;
  return null;
}

/** LINE 這一邊可以手動重試（失敗或可恢復的略過，不看次數） */
function lineRecoverable(e: EventRow): boolean {
  return e.status === 'failed' || (e.status === 'skipped' && e.skipReason !== null && RECOVERABLE_SKIPS.includes(e.skipReason));
}

/** 畫面上要不要顯示「重試」：任一邊可以重試、還有次數，而且在 24 小時內 */
export function canRetryEvent(e: EventRow, now: Date): boolean {
  if (now.getTime() - e.createdAt.getTime() > RETRY_WINDOW_MS) return false;
  return (lineRecoverable(e) && e.attemptCount < MAX_TOTAL_ATTEMPTS) || (e.telegramStatus === 'failed' && e.telegramAttemptCount < MAX_TOTAL_ATTEMPTS);
}

export type RetryResult = { ok: true; event: EventRow } | { ok: false; reason: string };

/** 手動重試失敗或可恢復的事件；已送出的那一邊不會再送 */
export async function retryEvent(deps: JobDeps, eventId: number): Promise<RetryResult> {
  const event = await deps.store.getEvent(eventId);
  if (!event) return { ok: false, reason: '找不到這筆事件' };
  const line = lineRecoverable(event);
  const telegram = event.telegramStatus === 'failed';
  if (!line && !telegram) return { ok: false, reason: event.status === 'sent' ? '這則訊息已經送出' : '這筆事件不能重試' };
  if (deps.now().getTime() - event.createdAt.getTime() > RETRY_WINDOW_MS) {
    return { ok: false, reason: '已超過 24 小時，為避免重複推播不再重試' };
  }
  if (!canRetryEvent(event, deps.now())) return { ok: false, reason: `已達重試上限（${MAX_TOTAL_ATTEMPTS} 次）` };
  const settings = await deps.store.getSettings();
  const kind: MessageKind = event.eventType === 'daily' ? 'daily' : event.eventType === 'test' ? 'test' : 'alert';
  // 每日推播重試時一樣送當天的卡片（日期取自事件鍵 daily:YYYY-MM-DD；卡片從資料庫重建，數字跟原本一樣）
  const dailyDate = event.eventType === 'daily' ? /^daily:(\d{4}-\d{2}-\d{2})$/.exec(event.idempotencyKey)?.[1] : undefined;
  const built = dailyDate ? await dailyMessages(deps, dailyDate) : null;
  return { ok: true, event: await deliverEvent(deps, event, kind, settings, { messages: built ? [built.card] : null, telegram: built?.telegram }) };
}

/** 管理介面的測試推播：每按一次是一個新事件。後面接一張每日行情卡片（最新一筆每日快照），方便確認實際樣子。 */
export async function sendTestPush(deps: JobDeps): Promise<{ event: EventRow; withCard: boolean }> {
  const settings = await deps.store.getSettings();
  const now = deps.now();
  const preview = await latestDailyPreview(deps).catch(() => null);
  const built = preview ? await dailyMessages(deps, preview.date) : null;
  const messageText = formatTestMessage(now, built !== null);
  const { event } = await deps.store.insertEvent({ eventType: 'test', idempotencyKey: `test:${deps.newId()}`, messageText });
  const delivered = await deliverEvent(deps, event, 'test', settings, {
    messages: built ? [textMessage(messageText), built.card] : null,
    telegram: buildTestTelegram(now, built?.telegram ?? null),
  });
  return { event: delivered, withCard: built !== null && delivered.lastError !== CARD_DROPPED_NOTE };
}
