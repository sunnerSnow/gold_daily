// 漲跌計算。參考價格不存在、為零或無效時，不產生漲跌幅（回傳 null）。

function isValidPrice(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export interface PriceChange {
  amount: number;
  percent: number;
}

/** changePercent = ((current - reference) / reference) * 100 */
export function computeChange(current: number | null | undefined, reference: number | null | undefined): PriceChange | null {
  if (!isValidPrice(current) || !isValidPrice(reference)) return null;
  const amount = current - reference;
  return { amount: round(amount, 4), percent: round((amount / reference) * 100, 4) };
}

/** 上漲幅度 = ((最新 - 基準) / 基準) * 100 */
export function risePercent(latest: number, baseline: number): number | null {
  if (!isValidPrice(latest) || !isValidPrice(baseline)) return null;
  return round(((latest - baseline) / baseline) * 100, 4);
}

/** 下跌幅度 = ((基準 - 最新) / 基準) * 100 */
export function fallPercent(latest: number, baseline: number): number | null {
  if (!isValidPrice(latest) || !isValidPrice(baseline)) return null;
  return round(((baseline - latest) / baseline) * 100, 4);
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function formatPrice(value: number | null | undefined, digits = 2): string {
  if (!isValidPrice(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** +28.40、−24.95（用數學減號） */
export function formatSigned(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return sign + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  const s = formatSigned(value, digits);
  return s === '—' ? s : `${s}%`;
}
