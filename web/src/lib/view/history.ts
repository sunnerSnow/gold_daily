import 'server-only';
import { computeChange } from '../gold/math';
import type { JobDeps } from '../jobs/deps';
import type { QuoteStatus } from '../gold/types';
import { taipeiDate } from '../time';

// 歷史資料：每日快照＋「那天排程有跑但沒取得有效報價」的缺漏日。漲跌以前一個有效交易日為基準。

export type HistoryKind = 'valid' | 'noref' | 'missing';
export type HistoryFilter = 'all' | HistoryKind;

export interface HistoryRow {
  date: string;
  kind: HistoryKind;
  price: number | null;
  changeAmount: number | null;
  changePercent: number | null;
  source: string;
  quoteTimestamp: Date | null;
  status: QuoteStatus | null;
  note: string;
}

export interface HistoryQuery {
  from: string;
  to: string;
  filter: HistoryFilter;
  page: number;
}

export const PAGE_SIZE = 20;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseHistoryQuery(sp: Record<string, string | string[] | undefined>, now: Date): HistoryQuery {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? '';
  const today = taipeiDate(now);
  const defFrom = taipeiDate(new Date(now.getTime() - 90 * 86_400_000));
  let from = ISO.test(one('from')) ? one('from') : defFrom;
  let to = ISO.test(one('to')) ? one('to') : today;
  if (from > to) [from, to] = [to, from];
  const f = one('status');
  const filter: HistoryFilter = f === 'valid' || f === 'noref' || f === 'missing' ? f : 'all';
  const page = Math.max(1, Math.floor(Number(one('page')) || 1));
  return { from, to, filter, page };
}

export async function loadHistory(deps: JobDeps, q: HistoryQuery) {
  const provider = deps.provider.getProviderStatus();
  if (!provider.instrument) return { rows: [], total: 0, pages: 1, page: 1, provider };
  const instrument = { source: deps.provider.id, symbol: provider.instrument.symbol };

  const { rows: snapshots } = await deps.store.listDailySnapshots({ instrument, to: q.to });
  const asc = snapshots
    .filter((s) => s.currency === provider.instrument!.currency && s.unit === provider.instrument!.unit)
    .reverse();

  const all: HistoryRow[] = [];
  let prev: { price: number; date: string } | null = null;
  for (const s of asc) {
    const change = prev ? computeChange(s.price, prev.price) : null;
    all.push({
      date: s.dailyDate!,
      kind: prev ? 'valid' : 'noref',
      price: s.price,
      changeAmount: change?.amount ?? null,
      changePercent: change?.percent ?? null,
      source: s.status === 'mock' ? 'Mock Provider' : s.source,
      quoteTimestamp: s.quoteTimestamp,
      status: s.status,
      note: prev ? '' : '第一筆快照，無法計算漲跌',
    });
    prev = { price: s.price, date: s.dailyDate! };
  }

  // 缺漏日：每日排程有執行，但沒寫入每日快照（失敗或報價過期）
  const have = new Set(all.map((r) => r.date));
  const runs = await deps.store.listJobRuns({ jobType: 'daily', limit: 500 });
  const missing = new Map<string, HistoryRow>();
  for (const run of runs) {
    if (run.status !== 'failed' && run.status !== 'skipped') continue;
    const date = taipeiDate(run.startedAt);
    if (have.has(date) || missing.has(date)) continue;
    missing.set(date, {
      date,
      kind: 'missing',
      price: null,
      changeAmount: null,
      changePercent: null,
      source: provider.isMock ? 'Mock Provider' : provider.name,
      quoteTimestamp: null,
      status: null,
      note: run.errorMessage ?? run.detail ?? '未取得有效報價',
    });
  }

  // 缺漏日之後那一天，註明參考價來自更早的有效交易日
  const dates = [...all.map((r) => r.date), ...missing.keys()].sort();
  for (let i = 1; i < all.length; i++) {
    const gapBetween = dates.some((d) => missing.has(d) && d > all[i - 1].date && d < all[i].date);
    if (gapBetween) all[i].note = `參考價取自 ${all[i - 1].date.slice(5).replace('-', '/')}（前一有效交易日）`;
  }

  const merged = [...all, ...missing.values()]
    .filter((r) => r.date >= q.from && r.date <= q.to)
    .filter((r) => q.filter === 'all' || r.kind === q.filter)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const pages = Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
  const page = Math.min(q.page, pages);
  return { rows: merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: merged.length, pages, page, provider };
}
