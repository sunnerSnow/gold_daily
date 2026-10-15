import { isTaipeiWeekend } from './schedule';
import type { SettingsRow } from './store/types';
import { parseHhmm, startOfTaipeiDay } from './time';

// 畫面上的報價是否「還是最新的」。系統只在排程時間查價（例如 09:00 與 21:30），
// 兩次查價之間沿用上一次的報價是正常的，不能只看「距今幾分鐘」就標成過期。
// 只有兩種情況算過期：
// 1. 查價當下行情來源就沒有更新（報價時間比取得時間早太多）
// 2. 排程沒有在預定時間查價（最新一筆比最近一次預定查價時間還舊）

type FreshnessSettings = Pick<SettingsRow, 'dailyEnabled' | 'dailyPushTime' | 'intradayMode' | 'checkTimes' | 'pollingIntervalMinutes' | 'skipWeekends'>;

/** 排程每 15 分鐘呼叫一次，再加上執行時間：預定時間過了這麼久還沒查到才算漏查 */
const GRACE_MS = 20 * 60_000;
/** 每日推播會沿用 10 分鐘內查過的報價，所以取得時間可能比預定時間早一點 */
const EARLY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

function slotMinutes(s: FreshnessSettings): number[] {
  const times = [...(s.dailyEnabled ? [s.dailyPushTime] : []), ...(s.intradayMode === 'times' ? s.checkTimes : [])];
  return [...new Set(times.map(parseHhmm).filter((m): m is number => m !== null))].sort((a, b) => a - b);
}

const isCheckDay = (s: FreshnessSettings, dayStart: Date) => !(s.skipWeekends && isTaipeiWeekend(new Date(dayStart.getTime() + 12 * 3600_000)));

/** 最近一次「應該已經查過價」的預定時間（已過寬限時間的才算）；沒有任何排程時回傳 null */
export function lastScheduledCheck(s: FreshnessSettings, now: Date): Date | null {
  const cutoff = now.getTime() - GRACE_MS;
  const interval = s.intradayMode === 'interval' && s.pollingIntervalMinutes > 0 ? s.pollingIntervalMinutes * 60_000 : null;
  const slots = slotMinutes(s);
  for (let d = 0; d < 8; d++) {
    const dayStart = new Date(startOfTaipeiDay(now).getTime() - d * DAY_MS);
    if (!isCheckDay(s, dayStart)) continue;
    // 固定間隔：查價日的整天都會查，最近一次預定時間＝寬限截止往前一個間隔（不早於當天開始）
    if (interval) return new Date(Math.max(dayStart.getTime(), Math.min(cutoff, dayStart.getTime() + DAY_MS) - interval));
    for (const m of [...slots].reverse()) {
      const at = dayStart.getTime() + m * 60_000;
      if (at <= cutoff) return new Date(at);
    }
  }
  return null;
}

/** 下一次預定查價時間（給畫面顯示）；沒有任何排程時回傳 null */
export function nextScheduledCheck(s: FreshnessSettings, now: Date, lastRunAt: Date | null = null): Date | null {
  const slots = slotMinutes(s);
  let next: number | null = null;
  for (let d = 0; d < 8 && next === null; d++) {
    const dayStart = new Date(startOfTaipeiDay(now).getTime() + d * DAY_MS);
    if (!isCheckDay(s, dayStart)) continue;
    for (const m of slots) {
      const at = dayStart.getTime() + m * 60_000;
      if (at > now.getTime()) {
        next = at;
        break;
      }
    }
  }
  if (s.intradayMode === 'interval' && s.pollingIntervalMinutes > 0 && isCheckDay(s, startOfTaipeiDay(now))) {
    const byInterval = lastRunAt ? Math.max(now.getTime(), lastRunAt.getTime() + s.pollingIntervalMinutes * 60_000) : now.getTime();
    next = next === null ? byInterval : Math.min(next, byInterval);
  }
  return next === null ? null : new Date(next);
}

export type QuoteFreshness =
  | { state: 'current' }
  /** 查價當下行情來源就沒有更新 */
  | { state: 'source_stale' }
  /** 排程沒有在預定時間查價 */
  | { state: 'missed'; expectedAt: Date };

export function assessQuote(
  quote: { quoteTimestamp: Date; fetchedAt: Date },
  s: FreshnessSettings,
  now: Date,
  staleAfterMinutes: number,
): QuoteFreshness {
  if (quote.fetchedAt.getTime() - quote.quoteTimestamp.getTime() > staleAfterMinutes * 60_000) return { state: 'source_stale' };
  const expectedAt = lastScheduledCheck(s, now);
  if (expectedAt && quote.fetchedAt.getTime() < expectedAt.getTime() - EARLY_MS) return { state: 'missed', expectedAt };
  return { state: 'current' };
}
