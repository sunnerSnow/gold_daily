import { z } from 'zod';
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

/** 報價是否已過期（行情來源沒有更新） */
export function isStale(quoteTimestamp: Date, now: Date, staleAfterMinutes: number): boolean {
  return now.getTime() - quoteTimestamp.getTime() > staleAfterMinutes * 60 * 1000;
}

/** 兩筆報價是否來自同一個商品與來源，可以互相比較 */
export function sameInstrument(
  a: Instrument & { source: string },
  b: Instrument & { source: string },
): boolean {
  return a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit && a.source === b.source;
}
