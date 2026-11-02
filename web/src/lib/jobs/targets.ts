import type { GoldQuote } from '../gold/types';
import { formatTargetMessage } from '../line/messages';
import type { EventRow, InstrumentKey, PriceTargetRow, SettingsRow } from '../store/types';
import type { JobDeps } from './deps';
import { deliverEvent } from './notify';

// 到價提醒：價格漲到目標價以上（above）或跌到以下（below）時送一則通知，然後自動關閉。
// 只比較同一個來源、商品、幣別、單位的價格。觸發用資料庫的原子更新，同一個目標價不會送兩次。
// 同一次查價、同一個方向有好幾個目標價都達到時，只推最接近目前價格的那一個，其他的一併關閉
// （例如設了跌到 3900、4000 以下，價格 3894 → 只推 3900，4000 在訊息裡註明並一起關閉）。

export function isTargetHit(t: Pick<PriceTargetRow, 'direction' | 'targetPrice'>, price: number): boolean {
  return t.direction === 'above' ? price >= t.targetPrice : price <= t.targetPrice;
}

const sameInstrument = (a: InstrumentKey, b: InstrumentKey) =>
  a.source === b.source && a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit;

/** 已達到的目標價中，越接近目前價格的排越前面（漲到以上：目標價高的優先；跌到以下：目標價低的優先） */
const closestFirst = (a: PriceTargetRow, b: PriceTargetRow) =>
  a.direction === 'above' ? b.targetPrice - a.targetPrice : a.targetPrice - b.targetPrice;

export interface TargetOutcome {
  target: PriceTargetRow;
  /** 同一次一起達到、沒有另外推播、跟著關閉的目標價 */
  merged: PriceTargetRow[];
  event: EventRow;
}

/** 排程紀錄用：「≤ 3900」，有一起關閉的再加上「，一併關閉 4000」 */
export function describeTargetHit(o: Pick<TargetOutcome, 'target' | 'merged'>): string {
  const head = `${o.target.direction === 'above' ? '≥' : '≤'} ${o.target.targetPrice}`;
  return o.merged.length > 0 ? `${head}，一併關閉 ${o.merged.map((t) => t.targetPrice).join('、')}` : head;
}

export async function evaluateTargets(
  deps: JobDeps,
  settings: SettingsRow,
  quote: GoldQuote,
  instrument: InstrumentKey,
): Promise<TargetOutcome[]> {
  const hits = (await deps.store.listPriceTargets({ statuses: ['active'], limit: 50 })).filter(
    (t) => sameInstrument(t, instrument) && isTargetHit(t, quote.price),
  );
  const results: TargetOutcome[] = [];
  for (const direction of ['above', 'below'] as const) {
    const triggered: PriceTargetRow[] = [];
    for (const t of hits.filter((h) => h.direction === direction).sort(closestFirst)) {
      const row = await deps.store.triggerPriceTarget(t.id, {
        triggeredAt: deps.now(),
        triggeredPrice: quote.price,
        triggeredQuoteAt: quote.timestamp,
      });
      if (row) triggered.push(row); // null：已經被別的排程觸發或被取消
    }
    if (triggered.length === 0) continue;
    const [primary, ...merged] = triggered;
    const { event } = await deps.store.insertEvent({
      eventType: 'target',
      idempotencyKey: `target:${primary.id}:${quote.timestamp.toISOString()}`,
      symbol: quote.symbol,
      currentPrice: quote.price,
      baselinePrice: primary.targetPrice,
      sourceTimestamp: quote.timestamp,
      messageText: formatTargetMessage({
        direction,
        price: quote.price,
        targetPrice: primary.targetPrice,
        alsoReached: merged.map((t) => t.targetPrice),
        symbol: quote.symbol,
        currency: quote.currency,
        unit: quote.unit,
        timestamp: quote.timestamp,
        source: quote.source,
        status: quote.status,
        note: primary.note,
      }),
    });
    for (const t of triggered) await deps.store.updatePriceTarget(t.id, { eventId: event.id });
    results.push({ target: primary, merged, event: await deliverEvent(deps, event, 'alert', settings) });
  }
  return results;
}
