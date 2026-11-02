import type { SettingsRow } from './store/types';
import { parseHhmm, startOfTaipeiDay, taipeiMinutesOfDay, taipeiParts } from './time';

// 排程判斷：排程服務每 15 分鐘呼叫一次，這裡依設定決定這次要不要真的查價。

const DAY_MS = 86_400_000;

/** 台北時間的星期（0 = 週日、6 = 週六） */
export function taipeiWeekday(date: Date): number {
  const p = taipeiParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** 台北時間是否為週六、週日（金市休市） */
export function isTaipeiWeekend(date: Date): boolean {
  const weekday = taipeiWeekday(date);
  return weekday === 0 || weekday === 6;
}

/** 週末不推播但週六推播時，每月大約多幾次週六 */
export const SATURDAYS_PER_MONTH = 4;

type ScheduleSettings = Pick<SettingsRow, 'intradayMode' | 'checkTimes' | 'pollingIntervalMinutes' | 'skipWeekends' | 'saturdayPush' | 'dailyEnabled'>;

/** 除了每日推播之外，是否還有盤中檢查 */
export function hasIntradayChecks(s: Pick<SettingsRow, 'intradayMode' | 'checkTimes' | 'pollingIntervalMinutes'>): boolean {
  if (s.intradayMode === 'times') return s.checkTimes.length > 0;
  if (s.intradayMode === 'interval') return s.pollingIntervalMinutes > 0;
  return false;
}

function slotMinutes(checkTimes: string[]): number[] {
  return checkTimes
    .map(parseHhmm)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
}

/** 固定時間模式：今天已經到了的最後一個檢查時間 */
export function latestSlot(checkTimes: string[], now: Date): Date | null {
  const mins = taipeiMinutesOfDay(now);
  const passed = slotMinutes(checkTimes).filter((m) => m <= mins);
  if (passed.length === 0) return null;
  return new Date(startOfTaipeiDay(now).getTime() + passed[passed.length - 1] * 60_000);
}

/** 下一次會查價的時間（給畫面顯示） */
export function nextCheckAt(s: ScheduleSettings, now: Date, lastRunAt: Date | null): Date | null {
  if (s.intradayMode === 'off') return null;
  if (s.intradayMode === 'interval') {
    if (s.pollingIntervalMinutes <= 0) return null;
    return lastRunAt ? new Date(lastRunAt.getTime() + s.pollingIntervalMinutes * 60_000) : now;
  }
  const slots = slotMinutes(s.checkTimes);
  if (slots.length === 0) return null;
  for (let d = 0; d < 8; d++) {
    const dayStart = new Date(startOfTaipeiDay(now).getTime() + d * DAY_MS);
    if (s.skipWeekends && isTaipeiWeekend(new Date(dayStart.getTime() + 12 * 3600_000))) continue;
    for (const m of slots) {
      const at = new Date(dayStart.getTime() + m * 60_000);
      if (at > now) return at;
    }
  }
  return null;
}

export type IntradayDue = { due: true; slot: Date | null } | { due: false; reason: string };

/** 這次排程呼叫是否要做盤中檢查 */
export function intradayDue(s: ScheduleSettings, now: Date, lastRunAt: Date | null): IntradayDue {
  if (s.intradayMode === 'off') return { due: false, reason: '未啟用盤中檢查（只用每日查價）' };
  if (s.skipWeekends && isTaipeiWeekend(now)) return { due: false, reason: '週末休市，不查價' };
  if (s.intradayMode === 'interval') {
    if (s.pollingIntervalMinutes <= 0) return { due: false, reason: '未設定檢查間隔' };
    // 排程觸發時間會有誤差，提早 2 分鐘內也算到期
    if (lastRunAt && now.getTime() - lastRunAt.getTime() < s.pollingIntervalMinutes * 60_000 - 2 * 60_000) {
      return { due: false, reason: `每 ${s.pollingIntervalMinutes} 分鐘檢查一次，尚未到期` };
    }
    return { due: true, slot: null };
  }
  const slot = latestSlot(s.checkTimes, now);
  if (!slot) return { due: false, reason: '今天的檢查時間還沒到' };
  if (lastRunAt && lastRunAt >= slot) return { due: false, reason: '這個時段已經檢查過' };
  return { due: true, slot };
}

/** 每日推播今天要不要跑：週末不推播時跳過週日；週六看「週六推播」設定（推週五美國盤的收盤價） */
export function isDailyDay(s: Pick<SettingsRow, 'skipWeekends' | 'saturdayPush'>, now: Date): boolean {
  if (!s.skipWeekends) return true;
  const weekday = taipeiWeekday(now);
  if (weekday === 0) return false;
  if (weekday === 6) return s.saturdayPush;
  return true;
}

/** 依設定估算每月要查價幾次（給畫面提示額度用） */
export function estimateMonthlyCalls(s: ScheduleSettings): number {
  const daily = s.dailyEnabled ? 1 : 0;
  let extra = 0;
  if (s.intradayMode === 'times') extra = s.checkTimes.length;
  if (s.intradayMode === 'interval' && s.pollingIntervalMinutes > 0) extra = Math.floor((24 * 60) / s.pollingIntervalMinutes);
  if (!s.skipWeekends) return 30 * (daily + extra);
  // 週六只有每日推播，沒有盤中檢查
  return 22 * (daily + extra) + (s.saturdayPush ? daily * SATURDAYS_PER_MONTH : 0);
}

/** "09:00, 21:30" → ['09:00', '21:30']；格式錯誤回傳 null */
export function parseCheckTimes(input: string): string[] | null {
  const parts = input
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    out.push(`${String(h).padStart(2, '0')}:${m[2]}`);
  }
  return [...new Set(out)].sort();
}
