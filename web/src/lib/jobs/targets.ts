import type { GoldQuote } from '../gold/types';
import { formatTargetMessage } from '../line/messages';
import type { EventRow, InstrumentKey, SettingsRow } from '../store/types';
import type { JobDeps } from './deps';
import { deliverEvent } from './notify';
import { findTargetHits, linkTargetHits, triggerTargetHits, type TargetHit } from './target-hits';

// 單獨推送的到價提醒。平常到價提醒併入每日推播（見 daily.ts），
// 只有每日推播停用時，才由盤中檢查（或手動執行每日查價）用這裡另外推一則。判斷規則見 target-hits.ts。

export interface TargetOutcome extends TargetHit {
  event: EventRow;
}

export async function evaluateTargets(
  deps: JobDeps,
  settings: SettingsRow,
  quote: GoldQuote,
  instrument: InstrumentKey,
): Promise<TargetOutcome[]> {
  const hits = await findTargetHits(deps, quote.price, instrument);
  // 先關閉再建事件：同一個目標價只會有一個排程關得掉，不會重複通知
  const closed = await triggerTargetHits(deps, hits, { triggeredAt: deps.now(), triggeredPrice: quote.price, triggeredQuoteAt: quote.timestamp });
  const results: TargetOutcome[] = [];
  for (const hit of closed) {
    const { event } = await deps.store.insertEvent({
      eventType: 'target',
      idempotencyKey: `target:${hit.target.id}:${quote.timestamp.toISOString()}`,
      symbol: quote.symbol,
      currentPrice: quote.price,
      baselinePrice: hit.target.targetPrice,
      sourceTimestamp: quote.timestamp,
      messageText: formatTargetMessage({
        direction: hit.target.direction,
        price: quote.price,
        targetPrice: hit.target.targetPrice,
        alsoReached: hit.merged.map((t) => t.targetPrice),
        symbol: quote.symbol,
        currency: quote.currency,
        unit: quote.unit,
        timestamp: quote.timestamp,
        source: quote.source,
        status: quote.status,
        note: hit.target.note,
      }),
    });
    await linkTargetHits(deps, [hit], event.id);
    results.push({ ...hit, event: await deliverEvent(deps, event, 'alert', settings) });
  }
  return results;
}
