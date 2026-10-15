import { computeChange } from '../gold/math';
import { formatDailyMessage } from '../line/messages';
import { isDailyDay } from '../schedule';
import type { EventRow, InstrumentKey, JobTrigger, SettingsRow, SnapshotRow } from '../store/types';
import { formatAge, parseHhmm, startOfTaipeiDay, taipeiDate, taipeiMinutesOfDay } from '../time';
import { ensureBaseline, evaluateAndNotify } from './alerts';
import { dailyChartUrl } from './chart-data';
import { safeErrorMessage, type JobDeps, type JobOutcome } from './deps';
import { CHART_DROPPED_NOTE, deliverEvent, MAX_TOTAL_ATTEMPTS, RECOVERABLE_SKIPS } from './notify';
import { getProviderBudget, meteredCall } from './provider-usage';
import { fetchAndRecord } from './snapshot';
import { evaluateTargets } from './targets';

// 每日行情：取得報價 → 驗證 → 存快照 → 找前一交易日參考價 → 計算漲跌 → 推播 → 記錄結果。
// 同一天重跑不會產生第二筆每日快照，也不會重複推播（事件鍵 daily:YYYY-MM-DD）。
// 今天的訊息已經產生後，補送只會重送同一則訊息，不會再查價（避免用掉行情 API 的次數）。
// 每日查價同時也是一次異動提醒與到價提醒的檢查。

const LOCK_TTL_SECONDS = 120;
/** sending 狀態超過這個時間沒更新，視為上次執行中斷，可以重送（沿用 retry key，不會重複） */
const STUCK_SENDING_MS = 2 * 60_000;
/** 額度不足而略過的事件，至少隔這麼久才再試，避免每 15 分鐘的排程一直重跑 */
const QUOTA_RECHECK_MS = 60 * 60_000;
/** 同一天最多嘗試幾次取得報價（行情來源中斷時避免一直呼叫） */
const MAX_FETCH_FAILURES_PER_DAY = 3;

export const dailyKey = (date: string) => `daily:${date}`;

/**
 * 今天的每日推播事件是否還需要處理。
 * force（手動執行）時，可恢復的略過一律再試一次，例如剛設定好 LINE。
 */
function needsDelivery(event: EventRow | null, now: Date, opts: { lineConfigured: boolean; force?: boolean }): boolean {
  if (!event) return true;
  switch (event.status) {
    case 'sent':
      return false;
    case 'failed':
      return event.attemptCount < MAX_TOTAL_ATTEMPTS;
    case 'skipped':
      if (!event.skipReason || !RECOVERABLE_SKIPS.includes(event.skipReason)) return false;
      if (opts.force) return true;
      // LINE 還沒連線就不用重跑；額度問題每小時最多再確認一次
      if (event.skipReason === 'line_not_configured') return opts.lineConfigured;
      return now.getTime() - event.updatedAt.getTime() > QUOTA_RECHECK_MS;
    case 'sending':
      return now.getTime() - event.updatedAt.getTime() > STUCK_SENDING_MS;
    default:
      return true;
  }
}

/** 資料庫沒有前一交易日時，向行情來源要歷史價格補上（同一來源、同一商品；有次數上限時要有餘額） */
async function findReference(deps: JobDeps, settings: SettingsRow, instrument: InstrumentKey, today: string): Promise<SnapshotRow | null> {
  const fromDb = await deps.store.getPreviousDailySnapshot(instrument, today);
  if (fromDb) return fromDb;
  const status = deps.provider.getProviderStatus();
  try {
    if (status.monthlyCallQuota !== null && !(await getProviderBudget(deps, settings)).canExtra) return null;
    const to = new Date(`${today}T00:00:00Z`);
    const from = new Date(to.getTime() - 10 * 86_400_000);
    const bars = (await meteredCall(deps, 'history', 'reference', () => deps.provider.getHistoricalPrice({ from, to }))).filter(
      (b) => b.date < today,
    );
    const bar = bars.at(-1);
    if (!bar) return null;
    const { snapshot } = await deps.store.insertSnapshot({
      ...instrument,
      price: bar.price,
      quoteTimestamp: bar.timestamp,
      fetchedAt: deps.now(),
      isDelayed: null,
      status: status.isMock ? 'mock' : 'valid',
    });
    await deps.store.markDailySnapshot(snapshot.id, bar.date);
    return deps.store.getPreviousDailySnapshot(instrument, today);
  } catch {
    return null; // 沒有歷史資料就不算漲跌，不猜
  }
}

export interface DailyOptions {
  trigger: JobTrigger;
}

export async function runDailyJob(deps: JobDeps, options: DailyOptions): Promise<JobOutcome> {
  const now = deps.now();
  const today = taipeiDate(now);
  const settings = await deps.store.getSettings();

  if (options.trigger === 'cron') {
    if (!settings.dailyEnabled) return { status: 'disabled', detail: '每日推播已停用' };
    if (!isDailyDay(settings, now)) return { status: 'disabled', detail: '週末休市，不推播' };
    const pushAt = parseHhmm(settings.dailyPushTime) ?? 9 * 60;
    if (taipeiMinutesOfDay(now) < pushAt) return { status: 'not_due', detail: `尚未到推播時間 ${settings.dailyPushTime}` };
    const existing = await deps.store.getEventByKey(dailyKey(today));
    if (existing && !needsDelivery(existing, now, { lineConfigured: deps.line.configured })) {
      return { status: 'not_due', detail: '今天的每日推播已處理' };
    }
    if (!existing) {
      const runs = await deps.store.listJobRuns({ jobType: 'daily', limit: 20 });
      const failuresToday = runs.filter((r) => r.status === 'failed' && r.startedAt >= startOfTaipeiDay(now)).length;
      if (failuresToday >= MAX_FETCH_FAILURES_PER_DAY) {
        return { status: 'not_due', detail: `今天已嘗試 ${failuresToday} 次仍無法取得報價，明天再試` };
      }
    }
  }

  const owner = deps.newId();
  if (!(await deps.store.tryAcquireLock('daily', owner, LOCK_TTL_SECONDS))) {
    return { status: 'locked', detail: '另一個每日排程正在執行' };
  }

  const run = await deps.store.startJobRun('daily', options.trigger);
  try {
    // 今天的訊息已經產生：只補送，不再查價
    const existing = await deps.store.getEventByKey(dailyKey(today));
    if (existing?.status === 'sent') {
      const detail = `今天已推播（${dailyKey(today)}），未重複送出`;
      await deps.store.finishJobRun(run.id, { status: 'skipped', detail });
      return { status: 'skipped', detail, jobRunId: run.id, eventIds: [existing.id] };
    }
    if (existing?.messageText) {
      let event = existing;
      let imageUrl: string | null = null;
      if (needsDelivery(event, now, { lineConfigured: deps.line.configured, force: options.trigger === 'manual' })) {
        imageUrl = await dailyChartUrl(deps, today);
        event = await deliverEvent(deps, event, 'daily', settings, { imageUrl });
      }
      const detail = `補送 ${dailyKey(today)}：${describeEvent(event)}${withChart(event, imageUrl)}（沿用今天的訊息，未重新查價）`;
      const status = event.status === 'failed' ? 'failed' : 'success';
      await deps.store.finishJobRun(run.id, { status, detail, errorMessage: event.status === 'failed' ? event.lastError : null });
      return { status, detail, jobRunId: run.id, eventIds: [event.id] };
    }

    const fetched = await fetchAndRecord(deps, settings, 'daily');
    if (fetched.kind === 'error') {
      await deps.store.finishJobRun(run.id, { status: 'failed', errorMessage: fetched.message, detail: '無法取得有效報價，未推播' });
      return { status: 'failed', detail: fetched.message, jobRunId: run.id };
    }

    const { quote, snapshot, instrument, stale } = fetched;
    let daily: SnapshotRow | null = null;
    if (!stale) {
      await deps.store.markDailySnapshot(snapshot.id, today);
      daily = await deps.store.getDailySnapshot(instrument, today);
    }

    const reference = await findReference(deps, settings, instrument, today);
    const price = daily?.price ?? quote.price;
    const change = computeChange(price, reference?.price);
    const messageText = formatDailyMessage({
      price,
      symbol: quote.symbol,
      currency: quote.currency,
      unit: quote.unit,
      referencePrice: reference?.price ?? null,
      changeAmount: change?.amount ?? null,
      changePercent: change?.percent ?? null,
      timestamp: daily?.quoteTimestamp ?? quote.timestamp,
      source: quote.source,
      status: quote.status,
      stale,
    });

    const eventIds: number[] = [];
    const detailParts: string[] = [
      stale
        ? `報價已過期（${formatAge(quote.timestamp, now)}），未寫入每日快照`
        : fetched.reused
          ? '沿用 10 分鐘內查過的報價'
          : fetched.created
            ? '寫入 1 筆快照'
            : '報價已存在，未重複寫入',
    ];
    let deliveryError: string | null = null;
    if (!settings.dailyEnabled) {
      detailParts.push('每日推播已停用，只記錄快照');
    } else {
      const { event: inserted } = await deps.store.insertEvent({
        eventType: 'daily',
        idempotencyKey: dailyKey(today),
        symbol: quote.symbol,
        currentPrice: price,
        baselinePrice: reference?.price ?? null,
        changePercent: change?.percent ?? null,
        sourceTimestamp: daily?.quoteTimestamp ?? quote.timestamp,
        messageText,
      });
      let event = inserted;
      let imageUrl: string | null = null;
      if (needsDelivery(event, now, { lineConfigured: deps.line.configured, force: options.trigger === 'manual' })) {
        // 過期報價沒有寫入當天的每日快照，畫不出到今天為止的走勢圖，只送文字
        imageUrl = daily ? await dailyChartUrl(deps, today) : null;
        event = await deliverEvent(deps, event, 'daily', settings, { imageUrl });
      }
      eventIds.push(event.id);
      detailParts.push(`推播 ${dailyKey(today)}：${describeEvent(event)}${withChart(event, imageUrl)}`);
      if (event.status === 'failed') deliveryError = event.lastError ?? 'LINE 發送失敗';
    }

    // 每日查價也是一次異動提醒與到價提醒的檢查（過期報價不判斷）
    if (!stale) {
      const fresh = await deps.store.getSettings();
      const baseline = await ensureBaseline(deps, fresh, instrument);
      if (fresh.alertEnabled) {
        const alert = await evaluateAndNotify(deps, fresh, quote, snapshot, baseline);
        if (alert.event && !alert.duplicate) {
          eventIds.push(alert.event.id);
          if (!alert.suppressed) detailParts.push(`${alert.decision.trigger && alert.decision.direction === 'up' ? '上漲' : '下跌'}提醒：${describeEvent(alert.event)}`);
        }
      }
      for (const t of await evaluateTargets(deps, fresh, quote, instrument)) {
        eventIds.push(t.event.id);
        detailParts.push(`到價提醒（${t.target.direction === 'above' ? '≥' : '≤'} ${t.target.targetPrice}）：${describeEvent(t.event)}`);
      }
    }

    const status = deliveryError ? 'failed' : stale ? 'skipped' : 'success';
    const detail = detailParts.join('；');
    await deps.store.finishJobRun(run.id, {
      status,
      recordsProcessed: fetched.created ? 1 : 0,
      detail,
      errorMessage: deliveryError,
    });
    return { status, detail, jobRunId: run.id, eventIds };
  } catch (err) {
    const message = safeErrorMessage(err);
    await deps.store.finishJobRun(run.id, { status: 'failed', errorMessage: message });
    return { status: 'failed', detail: message, jobRunId: run.id };
  } finally {
    await deps.store.releaseLock('daily', owner);
  }
}

/** 排程紀錄裡註明這次有沒有附走勢圖 */
function withChart(event: EventRow, imageUrl: string | null): string {
  if (event.status !== 'sent' || !imageUrl) return '';
  return event.lastError === CHART_DROPPED_NOTE ? '（走勢圖被 LINE 拒絕，只送文字）' : '（附走勢圖）';
}

export function describeEvent(event: EventRow): string {
  switch (event.status) {
    case 'sent':
      return '已送出';
    case 'failed':
      return `發送失敗（第 ${event.attemptCount} 次）`;
    case 'skipped':
      return {
        line_not_configured: '未發送：LINE 尚未連線',
        quota_unverified: '未發送：無法確認額度',
        quota_insufficient: '未發送：額度不足',
        cooldown: '冷卻中・未發送',
        stale_quote: '未發送：報價過期',
      }[event.skipReason ?? 'line_not_configured'];
    case 'sending':
      return '發送中';
    default:
      return '待發送';
  }
}
