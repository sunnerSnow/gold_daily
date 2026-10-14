import { evaluateAlert, isInCooldown, resolveBaseline, type AlertDecision, type ResolvedBaseline } from '../alerts/evaluate';
import type { GoldQuote } from '../gold/types';
import { formatAlertMessage } from '../line/messages';
import type { EventRow, InstrumentKey, SettingsRow, SnapshotRow } from '../store/types';
import { hasIntradayChecks } from '../schedule';
import { startOfTaipeiDay, taipeiDate } from '../time';
import type { JobDeps } from './deps';
import { deliverEvent } from './notify';

// 基準價建立與異動提醒。去重靠資料庫（idempotency key、事件紀錄），不靠記憶體變數。

/** 取得今天的基準價；需要時建立並寫回設定（之後同一天都沿用，不會每次查詢重設） */
export async function ensureBaseline(
  deps: JobDeps,
  settings: SettingsRow,
  instrument: InstrumentKey,
): Promise<ResolvedBaseline | null> {
  const now = deps.now();
  const today = taipeiDate(now);
  const needsLookup = settings.baselineMode !== 'manual' && settings.baselineDate !== today;
  const [firstSnapshotToday, previousDaily] = needsLookup
    ? await Promise.all([
        deps.store.getFirstSnapshotSince(instrument, startOfTaipeiDay(now)),
        deps.store.getPreviousDailySnapshot(instrument, today),
      ])
    : [null, null];
  const baseline = resolveBaseline({
    mode: settings.baselineMode,
    intradayChecks: hasIntradayChecks(settings),
    today,
    stored: { price: settings.baselinePrice, timestamp: settings.baselineTimestamp, date: settings.baselineDate },
    firstSnapshotToday,
    previousDaily,
  });
  if (baseline?.changed) {
    await deps.store.updateSettings({
      baselinePrice: baseline.price,
      baselineTimestamp: baseline.timestamp,
      baselineDate: baseline.date,
    });
  }
  return baseline;
}

export interface AlertOutcome {
  decision: AlertDecision;
  event: EventRow | null;
  suppressed: boolean;
  duplicate: boolean;
}

export async function evaluateAndNotify(
  deps: JobDeps,
  settings: SettingsRow,
  quote: GoldQuote,
  snapshot: SnapshotRow,
  baseline: ResolvedBaseline | null,
): Promise<AlertOutcome> {
  const decision = evaluateAlert({
    latestPrice: quote.price,
    baselinePrice: baseline?.price ?? null,
    riseThresholdPercent: settings.riseThresholdPercent,
    fallThresholdPercent: settings.fallThresholdPercent,
  });
  if (!decision.trigger || !baseline) return { decision, event: null, suppressed: false, duplicate: false };

  const now = deps.now();
  const eventType = decision.direction === 'up' ? 'alert_up' : 'alert_down';
  const fields = {
    symbol: quote.symbol,
    currentPrice: quote.price,
    baselinePrice: baseline.price,
    changePercent: decision.changePercent,
    thresholdPercent: decision.thresholdPercent,
    sourceTimestamp: quote.timestamp,
  };

  // 同一筆報價只處理一次（排程重試、系統重啟都不會重複）
  const idempotencyKey = `alert:${decision.direction}:${snapshot.source}:${snapshot.symbol}:${snapshot.quoteTimestamp.toISOString()}`;
  const already = await deps.store.getEventByKey(idempotencyKey);
  if (already) return { decision, event: already, suppressed: false, duplicate: true };

  // 冷卻時間內不重複提醒；同一段冷卻只記一筆「冷卻中・未發送」。
  // 因 LINE 未連線或額度不足而沒送出的提醒也算一次觸發，避免每次檢查都多記一筆；
  // 但「冷卻中」那筆本身不會延長冷卻。
  const since = new Date(now.getTime() - settings.cooldownMinutes * 60_000);
  const recent = await deps.store.listEvents({ types: [eventType], limit: 50 });
  const last = recent.find((e) => e.createdAt >= since && !(e.status === 'skipped' && e.skipReason === 'cooldown')) ?? null;
  if (last && isInCooldown(last.createdAt, now, settings.cooldownMinutes)) {
    const { event } = await deps.store.insertEvent({
      eventType,
      idempotencyKey: `cooldown:${eventType}:${last.id}`,
      status: 'skipped',
      skipReason: 'cooldown',
      ...fields,
    });
    return { decision, event, suppressed: true, duplicate: false };
  }

  const messageText = formatAlertMessage({
    direction: decision.direction,
    price: quote.price,
    currency: quote.currency,
    unit: quote.unit,
    baselinePrice: baseline.price,
    changePercent: decision.changePercent,
    thresholdPercent: decision.thresholdPercent,
    timestamp: quote.timestamp,
    source: quote.source,
    status: quote.status,
  });
  const { event, created } = await deps.store.insertEvent({ eventType, idempotencyKey, messageText, ...fields });
  if (!created) return { decision, event, suppressed: false, duplicate: true };
  return { decision, event: await deliverEvent(deps, event, 'alert', settings), suppressed: false, duplicate: false };
}
