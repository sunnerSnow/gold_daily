import { CHART_DAYS, chartImageUrl } from '../chart/daily-chart';
import { computeChange } from '../gold/math';
import { buildDailyCard, type FlexMessage } from '../line/flex';
import { formatDailyMessage, type DailyMessageInput } from '../line/messages';
import type { InstrumentKey, SnapshotRow } from '../store/types';
import type { JobDeps } from './deps';

// 走勢圖、每日卡片與每日訊息預覽用的資料。只讀資料庫裡的每日快照，不呼叫行情來源。

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

/** 每日卡片裡的走勢圖（精簡版）網址；沒有公開網址或資料不足時回傳 null（卡片照常送，只是沒有圖） */
export async function dailyChartUrl(deps: JobDeps, date: string): Promise<string | null> {
  const url = chartImageUrl(deps.appUrl, date, 'compact');
  if (!url) return null;
  try {
    return (await loadChartSnapshots(deps, date)) ? url : null;
  } catch {
    // 圖片只是附加內容，查不到資料也不能擋住推播
    return null;
  }
}

/**
 * 從資料庫重建某天的每日訊息資料：那天的每日快照＋前一筆每日快照。
 * 跟每日排程產生訊息時用的是同一組資料（findReference 也是取前一筆每日快照），所以補送、重試的數字跟原本一樣。
 * 每日快照只會由有效（未過期）的報價寫入，所以這裡一律不是過期資料。
 */
export async function dailyMessageInput(deps: JobDeps, date: string): Promise<{ input: DailyMessageInput; snapshot: SnapshotRow } | null> {
  const instrument = currentInstrument(deps);
  if (!instrument) return null;
  const snapshot = await deps.store.getDailySnapshot(instrument, date);
  if (!snapshot) return null;
  const prev = await deps.store.getPreviousDailySnapshot(instrument, date);
  const change = computeChange(snapshot.price, prev?.price);
  return {
    snapshot,
    input: {
      price: snapshot.price,
      symbol: snapshot.symbol,
      currency: snapshot.currency,
      unit: snapshot.unit,
      referencePrice: prev?.price ?? null,
      changeAmount: change?.amount ?? null,
      changePercent: change?.percent ?? null,
      timestamp: snapshot.quoteTimestamp,
      source: snapshot.source,
      status: snapshot.status,
      stale: false,
    },
  };
}

/** 某天的每日卡片（含精簡版走勢圖）；那天沒有每日快照時回傳 null，由呼叫端改送純文字 */
export async function dailyCard(deps: JobDeps, date: string): Promise<{ card: FlexMessage; withChart: boolean } | null> {
  try {
    const data = await dailyMessageInput(deps, date);
    if (!data) return null;
    const chartUrl = await dailyChartUrl(deps, date);
    const card = buildDailyCard(data.input, chartUrl);
    return card ? { card, withChart: chartUrl !== null } : null;
  } catch {
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
  const [data, chart] = await Promise.all([dailyMessageInput(deps, latest.dailyDate), loadChartSnapshots(deps, latest.dailyDate)]);
  if (!data) return null;
  return { text: formatDailyMessage(data.input), date: latest.dailyDate, snapshot: data.snapshot, chartAvailable: chart !== null };
}
