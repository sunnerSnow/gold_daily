import type { GoldQuote } from '../gold/types';
import { formatTargetMessage } from '../line/messages';
import type { EventRow, InstrumentKey, PriceTargetRow, SettingsRow } from '../store/types';
import type { JobDeps } from './deps';
import { deliverEvent } from './notify';

// 到價提醒：價格漲到目標價以上（above）或跌到以下（below）時送一則通知，然後自動關閉。
// 只比較同一個來源、商品、幣別、單位的價格。觸發用資料庫的原子更新，同一個目標價不會送兩次。

export function isTargetHit(t: Pick<PriceTargetRow, 'direction' | 'targetPrice'>, price: number): boolean {
  return t.direction === 'above' ? price >= t.targetPrice : price <= t.targetPrice;
}

const sameInstrument = (a: InstrumentKey, b: InstrumentKey) =>
  a.source === b.source && a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit;

export interface TargetOutcome {
  target: PriceTargetRow;
  event: EventRow;
}

export async function evaluateTargets(
  deps: JobDeps,
  settings: SettingsRow,
  quote: GoldQuote,
  instrument: InstrumentKey,
): Promise<TargetOutcome[]> {
  const active = (await deps.store.listPriceTargets({ statuses: ['active'], limit: 50 })).filter((t) => sameInstrument(t, instrument));
  const results: TargetOutcome[] = [];
  for (const t of active) {
    if (!isTargetHit(t, quote.price)) continue;
    const triggered = await deps.store.triggerPriceTarget(t.id, {
      triggeredAt: deps.now(),
      triggeredPrice: quote.price,
      triggeredQuoteAt: quote.timestamp,
    });
    if (!triggered) continue; // 已經被別的排程觸發或被取消
    const { event } = await deps.store.insertEvent({
      eventType: 'target',
      idempotencyKey: `target:${t.id}:${quote.timestamp.toISOString()}`,
      symbol: quote.symbol,
      currentPrice: quote.price,
      baselinePrice: t.targetPrice,
      sourceTimestamp: quote.timestamp,
      messageText: formatTargetMessage({
        direction: t.direction,
        price: quote.price,
        targetPrice: t.targetPrice,
        symbol: quote.symbol,
        currency: quote.currency,
        unit: quote.unit,
        timestamp: quote.timestamp,
        source: quote.source,
        status: quote.status,
        note: t.note,
      }),
    });
    await deps.store.updatePriceTarget(t.id, { eventId: event.id });
    results.push({ target: triggered, event: await deliverEvent(deps, event, 'alert', settings) });
  }
  return results;
}
