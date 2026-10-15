import 'server-only';
import { computeChange, type PriceChange } from '../gold/math';
import type { ProviderStatus } from '../gold/types';
import { isStale } from '../gold/validate';
import type { JobDeps } from '../jobs/deps';
import { computeQuotaState, type QuotaState } from '../quota/guard';
import type { ProviderBudget } from '../gold/budget';
import { getProviderBudget } from '../jobs/provider-usage';
import { nextCheckAt } from '../schedule';
import type { EventRow, InstrumentKey, JobRunRow, PriceTargetRow, SettingsRow, SnapshotRow } from '../store/types';
import { startOfLineBillingMonth, taipeiDate } from '../time';

// 儀表板需要的資料。所有數字都來自資料庫的實際紀錄，沒有資料就回傳 null，畫面顯示空狀態。

export interface ChartPoint {
  date: string;
  price: number;
}

export interface Gauge {
  baseline: number;
  baselineAt: Date | null;
  basis: SettingsRow['baselineMode'];
  riseAt: number;
  fallAt: number;
  /** 最新價在量尺上的位置 0–100 */
  position: number | null;
  /** 基準在量尺上的位置 0–100（上下門檻不同時不在正中間） */
  center: number;
  vsBase: number | null;
}

export interface DashboardData {
  now: Date;
  provider: ProviderStatus;
  instrument: InstrumentKey | null;
  settings: SettingsRow;
  latest: SnapshotRow | null;
  stale: boolean;
  reference: SnapshotRow | null;
  change: PriceChange | null;
  gauge: Gauge | null;
  history: ChartPoint[];
  lastRun: JobRunRow | null;
  lastDailyRun: JobRunRow | null;
  lastPush: EventRow | null;
  alerts: EventRow[];
  quota: QuotaState;
  nextIntradayAt: Date | null;
  /** 啟用中的到價提醒（只含目前行情來源的商品） */
  targets: PriceTargetRow[];
  /** 最近觸發或取消的到價提醒 */
  targetHistory: PriceTargetRow[];
  providerBudget: ProviderBudget;
}

export async function loadDashboard(deps: JobDeps): Promise<DashboardData> {
  const { store } = deps;
  const now = deps.now();
  const provider = deps.provider.getProviderStatus();
  const instrument: InstrumentKey | null = provider.instrument ? { source: deps.provider.id, ...provider.instrument } : null;
  const from = taipeiDate(new Date(now.getTime() - 90 * 86_400_000));

  // 第一批：彼此獨立的查詢一起送出（資料庫在遠端時，逐一查詢會很慢）
  const [settings, latest, historyRows, lastDailyRun, lastIntradayRun, lastPush, alerts, latestSync, localSent, allTargets] = await Promise.all([
    store.getSettings(),
    instrument ? store.getLatestSnapshot(instrument) : Promise.resolve(null),
    instrument ? store.listDailySnapshots({ instrument, from }).then((r) => r.rows) : Promise.resolve([]),
    store.getLastJobRun('daily'),
    store.getLastJobRun('intraday'),
    store.getLastEvent(['daily', 'alert_up', 'alert_down', 'target', 'test'], ['sent', 'failed', 'sending']),
    store.listEvents({ types: ['alert_up', 'alert_down', 'target'], limit: 5 }),
    store.getLatestQuotaSync({ successOnly: true }),
    store.countSentSince(startOfLineBillingMonth(now)),
    store.listPriceTargets({ limit: 50 }),
  ]);

  // 第二批：需要第一批結果的查詢
  const stale = latest ? isStale(latest.quoteTimestamp, now, provider.staleAfterMinutes) : false;
  const [reference, providerBudget] = await Promise.all([
    // 「今日漲跌」= 最新報價 vs 最新報價那天之前的有效交易日
    instrument && latest ? store.getPreviousDailySnapshot(instrument, taipeiDate(latest.quoteTimestamp)) : Promise.resolve(null),
    getProviderBudget(deps, settings),
  ]);
  const change = computeChange(latest?.price, reference?.price);

  const history = instrument
    ? historyRows
        .filter((r) => r.currency === instrument.currency && r.unit === instrument.unit)
        .map((r) => ({ date: r.dailyDate!, price: r.price }))
        .reverse()
    : [];

  const today = taipeiDate(now);
  let gauge: Gauge | null = null;
  const baselineValid = settings.baselinePrice !== null && (settings.baselineMode === 'manual' || settings.baselineDate === today);
  if (baselineValid) {
    const baseline = settings.baselinePrice!;
    const riseAt = baseline * (1 + settings.riseThresholdPercent / 100);
    const fallAt = baseline * (1 - settings.fallThresholdPercent / 100);
    const span = riseAt - fallAt;
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const position = latest && !stale ? clamp(((latest.price - fallAt) / span) * 100) : null;
    gauge = {
      baseline,
      baselineAt: settings.baselineTimestamp,
      basis: settings.baselineMode,
      riseAt,
      fallAt,
      position,
      center: clamp(((baseline - fallAt) / span) * 100),
      vsBase: latest && !stale ? computeChange(latest.price, baseline)?.percent ?? null : null,
    };
  }

  const lastRun = [lastDailyRun, lastIntradayRun]
    .filter((r): r is JobRunRow => r !== null)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;

  const nextIntradayAt = nextCheckAt(settings, now, lastIntradayRun?.startedAt ?? null);
  const sameInst = (t: PriceTargetRow) =>
    instrument !== null && t.source === instrument.source && t.symbol === instrument.symbol && t.currency === instrument.currency && t.unit === instrument.unit;
  const targets = allTargets.filter((t) => t.status === 'active' && sameInst(t)).sort((a, b) => a.targetPrice - b.targetPrice);
  const targetHistory = allTargets.filter((t) => t.status !== 'active').slice(0, 5);

  return {
    now,
    provider,
    instrument,
    settings,
    latest,
    stale,
    reference,
    change,
    gauge,
    history,
    lastRun,
    lastDailyRun,
    lastPush,
    alerts,
    quota: computeQuotaState({
      now,
      latestSuccessfulSync: latestSync,
      // 跟發送前的檢查一樣：每次送出都送給所有推播對象
      localSentThisMonth: localSent * Math.max(1, deps.line.recipientCount),
      monthlyMessageQuota: settings.monthlyMessageQuota,
      quotaSafetyBuffer: settings.quotaSafetyBuffer,
      dailyEnabled: settings.dailyEnabled,
      recipients: Math.max(1, deps.line.recipientCount),
    }),
    nextIntradayAt,
    targets,
    targetHistory,
    providerBudget,
  };
}
