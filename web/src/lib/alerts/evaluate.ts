import { fallPercent, risePercent } from '../gold/math';
import type { BaselineMode, SnapshotRow } from '../store/types';

// 異動提醒的純邏輯（不碰資料庫、不發訊息），方便測試。

export type AlertDecision =
  | { trigger: false; reason: 'no_baseline' | 'below_threshold'; rise: number | null; fall: number | null }
  | { trigger: true; direction: 'up' | 'down'; changePercent: number; thresholdPercent: number };

export interface AlertInput {
  latestPrice: number;
  baselinePrice: number | null;
  riseThresholdPercent: number;
  fallThresholdPercent: number;
}

/** 漲幅或跌幅「達到」門檻（≥）才觸發 */
export function evaluateAlert(i: AlertInput): AlertDecision {
  if (i.baselinePrice === null) return { trigger: false, reason: 'no_baseline', rise: null, fall: null };
  const rise = risePercent(i.latestPrice, i.baselinePrice);
  const fall = fallPercent(i.latestPrice, i.baselinePrice);
  if (rise === null || fall === null) return { trigger: false, reason: 'no_baseline', rise: null, fall: null };
  if (rise >= i.riseThresholdPercent) {
    return { trigger: true, direction: 'up', changePercent: rise, thresholdPercent: i.riseThresholdPercent };
  }
  if (fall >= i.fallThresholdPercent) {
    return { trigger: true, direction: 'down', changePercent: -fall, thresholdPercent: i.fallThresholdPercent };
  }
  return { trigger: false, reason: 'below_threshold', rise, fall };
}

/** 同方向上一則提醒還在冷卻時間內 */
export function isInCooldown(lastEventAt: Date | null, now: Date, cooldownMinutes: number): boolean {
  if (!lastEventAt) return false;
  return now.getTime() - lastEventAt.getTime() < cooldownMinutes * 60_000;
}

export interface StoredBaseline {
  price: number | null;
  timestamp: Date | null;
  date: string | null;
}

export interface BaselineContext {
  mode: BaselineMode;
  /** 除了每日推播之外是否還有盤中檢查 */
  intradayChecks: boolean;
  /** 今天（台北）YYYY-MM-DD */
  today: string;
  stored: StoredBaseline;
  /** 今天最早的一筆有效快照 */
  firstSnapshotToday: SnapshotRow | null;
  /** 前一交易日的每日快照 */
  previousDaily: SnapshotRow | null;
}

export interface ResolvedBaseline {
  price: number;
  timestamp: Date;
  /** 適用日期；手動模式為 null */
  date: string | null;
  /** true 代表新建立，需要寫回設定 */
  changed: boolean;
  basis: 'first_valid_of_day' | 'previous_close' | 'manual';
}

/**
 * 基準價規則：
 * - first_valid_of_day（預設）：每個台北日期第一次取得的有效報價；建立後當天不再變動。
 *   只用每日查價（不做盤中檢查）時，當日首筆就是每日報價本身，比較沒有意義，所以改用前一交易日參考價。
 * - previous_close：前一個有效交易日的每日快照價格，每天換一次。
 * - manual：使用者手動輸入的價格，不會自動重設。
 */
export function resolveBaseline(ctx: BaselineContext): ResolvedBaseline | null {
  if (ctx.mode === 'manual') {
    if (ctx.stored.price === null) return null;
    return {
      price: ctx.stored.price,
      timestamp: ctx.stored.timestamp ?? new Date(0),
      date: null,
      changed: false,
      basis: 'manual',
    };
  }

  const basis = ctx.mode === 'first_valid_of_day' && !ctx.intradayChecks ? 'previous_close' : ctx.mode;

  if (ctx.stored.date === ctx.today && ctx.stored.price !== null && ctx.stored.timestamp !== null) {
    return { price: ctx.stored.price, timestamp: ctx.stored.timestamp, date: ctx.today, changed: false, basis };
  }

  const source = basis === 'first_valid_of_day' ? ctx.firstSnapshotToday : ctx.previousDaily;
  if (!source) return null;
  return { price: source.price, timestamp: source.quoteTimestamp, date: ctx.today, changed: true, basis };
}
