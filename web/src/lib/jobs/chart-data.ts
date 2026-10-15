import { CHART_DAYS, chartImageUrl } from '../chart/daily-chart';
import { computeChange } from '../gold/math';
import { isStale } from '../gold/validate';
import { formatDailyMessage } from '../line/messages';
import type { InstrumentKey, SnapshotRow } from '../store/types';
import { taipeiDate } from '../time';
import type { JobDeps } from './deps';

// 走勢圖與每日訊息預覽用的資料。只讀資料庫裡的每日快照，不呼叫行情來源。

function currentInstrument(deps: JobDeps): InstrumentKey | null {
  const instrument = deps.provider.getProviderStatus().instrument;
  return instrument ? { source: deps.provider.id, ...instrument } : null;
}

/**
 * 截至 date（含）最近 CHART_DAYS 個交易日的每日快照，由舊到新。
 * 那天沒有每日快照、或不到 2 個點畫不出走勢時回傳 null。
 */
export async function loadChartSnapshots(deps: JobDeps, date: string): Promise<{ instrument: InstrumentKey; rows: SnapshotRow[] } | null> {
  const instrument = currentInstrument(deps);
  if (!instrument) return null;
  const { rows } = await deps.store.listDailySnapshots({ instrument, to: date, limit: CHART_DAYS });
  // 不同幣別或單位不能畫在同一條線上
  const same = rows.filter((r) => r.currency === instrument.currency && r.unit === instrument.unit);
  if (same.length < 2 || same[0].dailyDate !== date) return null;
  return { instrument, rows: same.reverse() };
}

/** 每日推播要附的走勢圖網址；沒有公開網址或資料不足時回傳 null（照常只送文字） */
export async function dailyChartUrl(deps: JobDeps, date: string): Promise<string | null> {
  const url = chartImageUrl(deps.appUrl, date);
  if (!url) return null;
  try {
    return (await loadChartSnapshots(deps, date)) ? url : null;
  } catch {
    // 圖片只是附加內容，查不到資料也不能擋住文字推播
    return null;
  }
}

export interface DailyPreview {
  text: string;
  date: string;
  snapshot: SnapshotRow;
  /** 這一天的走勢圖畫得出來 */
  chartAvailable: boolean;
}

/** 用最新一筆每日快照與它的前一交易日組成每日訊息（設定頁預覽與測試推播共用） */
export async function latestDailyPreview(deps: JobDeps): Promise<DailyPreview | null> {
  const instrument = currentInstrument(deps);
  if (!instrument) return null;
  const latest = (await deps.store.listDailySnapshots({ instrument, limit: 1 })).rows[0] ?? null;
  if (!latest?.dailyDate) return null;
  const [prev, chart] = await Promise.all([
    deps.store.getPreviousDailySnapshot(instrument, latest.dailyDate),
    loadChartSnapshots(deps, latest.dailyDate),
  ]);
  const change = computeChange(latest.price, prev?.price);
  const now = deps.now();
  const text = formatDailyMessage({
    price: latest.price,
    symbol: latest.symbol,
    currency: latest.currency,
    unit: latest.unit,
    referencePrice: prev?.price ?? null,
    changeAmount: change?.amount ?? null,
    changePercent: change?.percent ?? null,
    timestamp: latest.quoteTimestamp,
    source: latest.source,
    status: latest.status,
    stale: isStale(latest.quoteTimestamp, now, deps.provider.getProviderStatus().staleAfterMinutes) && latest.dailyDate === taipeiDate(now),
  });
  return { text, date: latest.dailyDate, snapshot: latest, chartAvailable: chart !== null };
}
