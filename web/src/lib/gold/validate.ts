import { z } from 'zod';
import { taipeiParts } from '../time';
import type { GoldQuote, Instrument } from './types';

// 驗證 Provider 回傳的報價：價格、時間戳、商品代號、幣別、單位都要對得上。

const quoteSchema = z.object({
  symbol: z.string().min(1),
  price: z.number().finite().positive(),
  currency: z.string().min(3).max(8),
  unit: z.enum(['troy_oz', 'gram']),
  source: z.string().min(1),
  timestamp: z.date(),
  fetchedAt: z.date(),
  isDelayed: z.boolean().nullable(),
  status: z.enum(['valid', 'delayed', 'mock']),
});

export type QuoteValidation =
  | { ok: true; quote: GoldQuote }
  | { ok: false; reason: string };

/** 報價時間比取得時間晚超過這個容許值，視為時間戳錯誤 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function validateQuote(raw: unknown, expected: Instrument): QuoteValidation {
  const parsed = quoteSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `報價格式錯誤：${first?.path.join('.') || '資料'} ${first?.message ?? ''}`.trim() };
  }
  const q = parsed.data;
  if (Number.isNaN(q.timestamp.getTime()) || Number.isNaN(q.fetchedAt.getTime())) {
    return { ok: false, reason: '報價時間戳無效' };
  }
  if (q.timestamp.getTime() - q.fetchedAt.getTime() > FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: '報價時間晚於取得時間，時間戳不可信' };
  }
  if (q.symbol !== expected.symbol) {
    return { ok: false, reason: `商品代號不符：預期 ${expected.symbol}，收到 ${q.symbol}` };
  }
  if (q.currency !== expected.currency) {
    return { ok: false, reason: `幣別不符：預期 ${expected.currency}，收到 ${q.currency}` };
  }
  if (q.unit !== expected.unit) {
    return { ok: false, reason: `報價單位不符：預期 ${expected.unit}，收到 ${q.unit}` };
  }
  return { ok: true, quote: q };
}

/** 報價是否已過期（行情來源沒有更新）；週六拿到的當週收盤價不算過期 */
export function isStale(quoteTimestamp: Date, now: Date, staleAfterMinutes: number): boolean {
  if (isSaturdayClose(quoteTimestamp, now)) return false;
  return now.getTime() - quoteTimestamp.getTime() > staleAfterMinutes * 60 * 1000;
}

/**
 * 週六的當週收盤價。國際金價在台北時間週六清晨收盤（夏令約 05:00、冬令約 06:00），到週一清晨開盤前都不會更新。
 * 週六當天拿到的是當天清晨的收盤價（週五美國盤的結果），雖然超過過期門檻，仍是有效、而且是新的價格。
 * 條件只看「報價時間是週六當天」：各家行情來源週末回傳的時間戳不一定剛好是收盤那一刻，
 * 卡太嚴會讓週六推播整則變成「報價過期」；報價時間本來就會顯示在訊息上。
 * 週五（含）以前的報價、或週日拿到的同一筆價格都算過期（沒有新資訊）。
 */
export function isSaturdayClose(quoteTimestamp: Date, now: Date): boolean {
  if (quoteTimestamp.getTime() > now.getTime()) return false;
  const q = taipeiParts(quoteTimestamp);
  const n = taipeiParts(now);
  const saturday = new Date(Date.UTC(n.year, n.month - 1, n.day)).getUTCDay() === 6;
  return saturday && q.year === n.year && q.month === n.month && q.day === n.day;
}

/** 兩筆報價是否來自同一個商品與來源，可以互相比較 */
export function sameInstrument(
  a: Instrument & { source: string },
  b: Instrument & { source: string },
): boolean {
  return a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit && a.source === b.source;
}
