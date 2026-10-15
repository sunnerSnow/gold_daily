import { formatPercent, formatPrice, formatSigned } from '../gold/math';
import { UNIT_LABEL, type PriceUnit, type QuoteStatus } from '../gold/types';
import { changeDirection, describeSource, DIRECTION_MARK, instrumentName, type Direction } from '../line/messages';
import { formatDateLabel } from '../time';

// 每日推播附的走勢圖：網址規則、圖表座標與圖上文字（純函式，不碰資料庫）。
// 圖片由 /api/chart/<日期>.png 產生，只用資料庫裡的每日快照，不會呼叫行情來源。

/** 圖上最多畫幾個交易日 */
export const CHART_DAYS = 30;
export const CHART_WIDTH = 1040;
export const CHART_HEIGHT = 650;

/** 圖片字型（src/assets/fonts 的 Noto Sans TC 子集）只收錄這些中文字與符號，加上所有 ASCII。 */
export const CHART_GLYPHS = '國際現貨黃金近個交易日走勢較前一期間最高低資料來源每快照台灣時間模擬非真實行情衡盎司公克日一二三四五六（）・：—▲▼−±';

export const CHART_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.png$/;

export function chartPath(date: string): string {
  return `/api/chart/${date}.png`;
}

/**
 * 網站對外網址：優先用 NEXT_PUBLIC_APP_URL，沒設定時用 Vercel 自動提供的正式網域。
 * 回傳 origin（不含路徑）；判斷不出來時回傳 null。
 */
export function resolveAppUrl(env: { NEXT_PUBLIC_APP_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string }): string | null {
  const raw = env.NEXT_PUBLIC_APP_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** LINE 只接受 https 的圖片網址；本機的 http://localhost 不附圖 */
export function chartImageUrl(appUrl: string | null | undefined, date: string): string | null {
  if (!appUrl || !appUrl.startsWith('https://')) return null;
  return `${appUrl}${chartPath(date)}`;
}

export interface ChartPoint {
  date: string;
  price: number;
}

export interface PlotPoint extends ChartPoint {
  x: number;
  y: number;
}

export interface ChartModel {
  points: PlotPoint[];
  /** SVG path：折線 */
  line: string;
  /** SVG path：折線下方的填色區 */
  area: string;
  ticks: { value: number; y: number }[];
  high: PlotPoint;
  low: PlotPoint;
  first: PlotPoint;
  last: PlotPoint;
  /** 要標在 X 軸的日期（第一天、中間、最後一天） */
  xLabels: PlotPoint[];
}

/** 1、2、2.5、5 × 10ⁿ 的刻度間距 */
export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * series 由舊到新。少於 2 個點畫不出走勢，回傳 null。
 * 座標以繪圖區左上角為原點，寬 width、高 height；inset 是左右留白，讓端點的圓點不被裁掉。
 */
export function buildChartModel(series: ChartPoint[], width: number, height: number, inset = 0): ChartModel | null {
  const valid = series.filter((p) => Number.isFinite(p.price) && p.price > 0);
  if (valid.length < 2) return null;

  const prices = valid.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  // 全部同價時給一點高度，線才不會貼在邊上
  const span = hi - lo || hi * 0.01;
  const step = niceStep(span / 4);
  const min = Math.floor((lo - span * 0.08) / step) * step;
  const max = Math.ceil((hi + span * 0.08) / step) * step;

  const x = (i: number) => r1(inset + (i / (valid.length - 1)) * (width - inset * 2));
  const y = (v: number) => r1(height - ((v - min) / (max - min)) * height);
  const points = valid.map((p, i) => ({ ...p, x: x(i), y: y(p.price) }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const area = `${line} L${points[points.length - 1].x} ${height} L${points[0].x} ${height} Z`;

  const ticks: { value: number; y: number }[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push({ value: v, y: y(v) });

  const high = points.reduce((a, b) => (b.price > a.price ? b : a));
  const low = points.reduce((a, b) => (b.price < a.price ? b : a));
  const mid = Math.floor((points.length - 1) / 2);
  const xLabels = points.length >= 5 ? [points[0], points[mid], points[points.length - 1]] : [points[0], points[points.length - 1]];

  return { points, line, area, ticks, high, low, first: points[0], last: points[points.length - 1], xLabels };
}

/** 2026-10-14 → 10/14 */
export function shortDate(isoDate: string): string {
  return `${isoDate.slice(5, 7)}/${isoDate.slice(8, 10)}`;
}

export interface ChartInfo {
  source: string;
  symbol: string;
  currency: string;
  unit: PriceUnit;
  status: QuoteStatus;
  /** 圖的最後一天（YYYY-MM-DD） */
  date: string;
}

export interface ChartLabels {
  title: string;
  price: string;
  unit: string;
  /** 最後一天相對前一交易日的漲跌；跟每日訊息用同一套箭頭 */
  change: string;
  tone: Direction;
  date: string;
  high: string;
  low: string;
  source: string;
  ticks: string[];
  xLabels: string[];
}

/** 圖上所有文字。字型只收錄 CHART_GLYPHS，這裡用到的字都要在裡面（有測試檢查） */
export function buildChartLabels(model: ChartModel, info: ChartInfo): ChartLabels {
  const prev = model.points[model.points.length - 2];
  const amount = model.last.price - prev.price;
  const percent = (amount / prev.price) * 100;
  const tone = changeDirection(amount);
  return {
    title: `${instrumentName(info)}・近 ${model.points.length} 個交易日`,
    price: formatPrice(model.last.price),
    unit: `${info.currency} / ${UNIT_LABEL[info.unit]}`,
    change: tone === 'flat' ? `${DIRECTION_MARK.flat} 0.00（0.00%）` : `${DIRECTION_MARK[tone]} ${formatSigned(amount)}（${formatPercent(percent)}）`,
    tone,
    date: formatDateLabel(info.date),
    high: `期間最高 ${formatPrice(model.high.price)}`,
    low: `期間最低 ${formatPrice(model.low.price)}`,
    source: `資料來源：${info.status === 'mock' ? 'Mock Provider（模擬資料）' : describeSource(info.source, info.status)}・每日快照・台灣時間`,
    ticks: model.ticks.map((t) => formatPrice(t.value, 0)),
    xLabels: model.xLabels.map((p) => shortDate(p.date)),
  };
}
