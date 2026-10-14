// 行情 API 查價次數保護（例如 GoldAPI 免費方案每月 100 次）。原則與 LINE 額度保護相同：
// 1. 每次呼叫前先在資料庫記一筆，以本地紀錄計數（不依賴供應商的用量查詢，因為那也可能算次數）。
// 2. 預留安全緩衝，避免月份切換時間不同、手動查詢等造成超額。
// 3. 每日推播優先：盤中檢查、手動執行、回填要留下本月剩餘每日推播需要的次數。

/** 保留給時區差異與意外重試的安全緩衝 */
export const PROVIDER_SAFETY_MARGIN = 10;

export interface ProviderBudgetInput {
  /** 供應商的每月上限；null = 沒有上限（例如 Mock） */
  monthlyQuota: number | null;
  /** 本月（UTC 日曆月）已呼叫次數 */
  used: number;
  /** 本月剩餘每日推播次數（含今天尚未執行的那次） */
  remainingDailyRuns: number;
}

export interface ProviderBudget {
  limited: boolean;
  monthlyQuota: number | null;
  /** 實際允許使用的上限（扣掉安全緩衝） */
  cap: number | null;
  used: number;
  remaining: number | null;
  reserveForDaily: number;
  canDaily: boolean;
  canExtra: boolean;
  reason: string | null;
}

export function computeProviderBudget(i: ProviderBudgetInput): ProviderBudget {
  if (i.monthlyQuota === null) {
    return {
      limited: false,
      monthlyQuota: null,
      cap: null,
      used: i.used,
      remaining: null,
      reserveForDaily: 0,
      canDaily: true,
      canExtra: true,
      reason: null,
    };
  }
  const cap = Math.max(0, i.monthlyQuota - PROVIDER_SAFETY_MARGIN);
  const remaining = Math.max(0, cap - i.used);
  const canDaily = remaining >= 1;
  const canExtra = remaining - i.remainingDailyRuns >= 1;
  let reason: string | null = null;
  if (!canDaily) reason = `本月查價次數已達上限（${i.used}／${cap} 次，保留 ${PROVIDER_SAFETY_MARGIN} 次緩衝），暫停查價。`;
  else if (!canExtra) reason = `剩餘 ${remaining} 次查價，需保留 ${i.remainingDailyRuns} 次給本月的每日推播，暫停盤中檢查與手動查價。`;
  return {
    limited: true,
    monthlyQuota: i.monthlyQuota,
    cap,
    used: i.used,
    remaining,
    reserveForDaily: i.remainingDailyRuns,
    canDaily,
    canExtra,
    reason,
  };
}

/** UTC 日曆月的起點（GoldAPI 的用量以日曆月計算，時區未載明，所以另外留了安全緩衝） */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * 本月（UTC）還會跑幾次每日推播：從今天（若今天還沒跑）到月底，週末不推播時只算平日。
 */
export function remainingDailyRuns(now: Date, opts: { dailyEnabled: boolean; skipWeekends: boolean; dailyDoneToday: boolean }): number {
  if (!opts.dailyEnabled) return 0;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  let count = 0;
  for (let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); t < end.getTime(); t += 86_400_000) {
    const d = new Date(t);
    const isToday = d.getUTCDate() === now.getUTCDate();
    if (isToday && opts.dailyDoneToday) continue;
    const w = d.getUTCDay();
    if (opts.skipWeekends && (w === 0 || w === 6)) continue;
    count += 1;
  }
  return count;
}
