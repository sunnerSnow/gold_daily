import { formatPercent, formatPrice, formatSigned, round } from '../gold/math';
import { UNIT_LABEL, type PriceUnit, type QuoteStatus } from '../gold/types';
import { formatDateLabel, formatTaipei, taipeiDate } from '../time';

// 推播訊息格式。所有數字都來自實際資料；算不出來的欄位寫「暫無有效資料」或直接省略，不填假數字。
// 每日推播、異動提醒、到價提醒共用下面的格式化函式，各自保留需要的欄位。

export const REFERENCE_CHART_URL = 'https://www.truney.com/gold-chart';
export const NO_DATA = '暫無有效資料';

const CHART_LINK = ['查看黃金走勢：', REFERENCE_CHART_URL];

export interface DataStatusInput {
  status: QuoteStatus;
  stale: boolean;
}

const SOURCE_NAMES: Record<string, string> = { goldapi: 'GoldAPI.io' };

export function describeSource(source: string, status: QuoteStatus): string {
  if (status === 'mock') return 'Mock Provider（模擬資料，非真實行情）';
  return SOURCE_NAMES[source] ?? source;
}

/** 過期的報價不能標成有效 */
export function describeDataStatus({ status, stale }: DataStatusInput): string {
  const base = stale ? '過期（行情來源未更新）' : status === 'delayed' ? '有效（延遲報價）' : '有效';
  return status === 'mock' ? `${base}（模擬）` : base;
}

const mockFlag = (status: QuoteStatus) => (status === 'mock' ? '【模擬資料】' : '');

const isValidPrice = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isFiniteNumber = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export interface InstrumentLabelInput {
  source: string;
  symbol: string;
  currency: string;
  status: QuoteStatus;
}

/** 只有 GoldAPI 的 XAU 報價（例如 XAUUSD）才稱為「國際現貨黃金」；其他來源直接顯示商品代號 */
export function instrumentName({ source, symbol, currency, status }: InstrumentLabelInput): string {
  if (status === 'mock') return `${symbol}（模擬資料）`;
  if (source === 'goldapi' && symbol.toUpperCase() === `XAU${currency.toUpperCase()}`) return '國際現貨黃金';
  return symbol;
}

/** 4,161.51 USD / 金衡盎司 */
export function formatPriceWithUnit(price: number, currency: string, unit: PriceUnit): string {
  return `${formatPrice(price)} ${currency} / ${UNIT_LABEL[unit]}`;
}

export type Direction = 'up' | 'down' | 'flat';

/** 用顯示到小數第二位的金額判斷方向，避免出現「▲ +0.00」 */
export function changeDirection(amount: number): Direction {
  const r = round(amount, 2);
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

export const DIRECTION_MARK: Record<Direction, string> = { up: '▲', down: '▼', flat: '—' };

/** ▼ −20.95 USD（−0.50%）；持平時 — 0.00 USD（0.00%） */
export function formatChangeLine(amount: number, percent: number, currency: string): string {
  const d = changeDirection(amount);
  if (d === 'flat') return `${DIRECTION_MARK.flat} 0.00 ${currency}（0.00%）`;
  return `${DIRECTION_MARK[d]} ${formatSigned(amount)} ${currency}（${formatPercent(percent)}）`;
}

/** 只描述數字本身，不做預測或建議 */
function changeSummary(amount: number, percent: number): string {
  const d = changeDirection(amount);
  if (d === 'flat') return '➖ 本次報價與前一交易日持平。';
  // formatPercent 會帶正負號，這裡只要絕對值（例如 0.50%）；太小時不寫成 0.00%
  const size = Math.abs(percent) < 0.005 ? '不到 0.01%' : ` ${formatPercent(Math.abs(percent)).slice(1)}`;
  return d === 'up' ? `📈 本次報價較前一交易日上漲${size}。` : `📉 本次報價較前一交易日下跌${size}。`;
}

export interface DailyMessageInput {
  price: number;
  symbol: string;
  currency: string;
  unit: PriceUnit;
  referencePrice: number | null;
  changeAmount: number | null;
  changePercent: number | null;
  timestamp: Date;
  source: string;
  status: QuoteStatus;
  stale: boolean;
}

export function formatDailyMessage(i: DailyMessageInput): string {
  const validTime = !Number.isNaN(i.timestamp.getTime());
  // 報價日期依實際時間戳換算成台北日期（Intl 換算，不手動加 8 小時）
  const lines = [`${mockFlag(i.status)}🥇 黃金每日行情`, validTime ? `${formatDateLabel(taipeiDate(i.timestamp))}・台灣時間` : '台灣時間', ''];
  const source = `資料來源：${describeSource(i.source, i.status)}`;

  if (!isValidPrice(i.price) || !validTime) {
    lines.push(NO_DATA, '', source, '資料狀態：異常（報價無效）', '', ...CHART_LINK);
    return lines.join('\n');
  }

  lines.push(instrumentName(i), formatPriceWithUnit(i.price, i.currency, i.unit));
  const hasChange = isValidPrice(i.referencePrice) && isFiniteNumber(i.changeAmount) && isFiniteNumber(i.changePercent);
  if (hasChange) lines.push('', formatChangeLine(i.changeAmount!, i.changePercent!, i.currency));

  lines.push(
    '',
    `前一交易日：${isValidPrice(i.referencePrice) ? `${formatPrice(i.referencePrice)} ${i.currency}` : NO_DATA}`,
    `報價時間：${formatTaipei(i.timestamp)}`,
    source,
    `資料狀態：${describeDataStatus(i)}`,
  );

  const summary = i.stale
    ? '⚠️ 行情來源未更新，這筆報價已過期，漲跌僅反映該筆報價。'
    : hasChange
      ? changeSummary(i.changeAmount!, i.changePercent!)
      : null;
  if (summary) lines.push('', summary);
  lines.push('', ...CHART_LINK);
  return lines.join('\n');
}

export interface AlertMessageInput {
  direction: 'up' | 'down';
  price: number;
  symbol: string;
  currency: string;
  unit: PriceUnit;
  baselinePrice: number;
  changePercent: number;
  thresholdPercent: number;
  timestamp: Date;
  source: string;
  status: QuoteStatus;
}

export function formatAlertMessage(i: AlertMessageInput): string {
  const condition = i.direction === 'up' ? `上漲 ≥ ${i.thresholdPercent}%` : `下跌 ≥ ${i.thresholdPercent}%`;
  return [
    `${mockFlag(i.status)}🔔 黃金價格異動提醒`,
    instrumentName(i),
    '',
    `目前價格：${formatPriceWithUnit(i.price, i.currency, i.unit)}`,
    `參考價格：${formatPrice(i.baselinePrice)} ${i.currency}`,
    `價格變化：${DIRECTION_MARK[i.direction]} ${formatPercent(i.changePercent)}`,
    `觸發條件：${condition}`,
    `觸發時間：${formatTaipei(i.timestamp)}`,
    `資料來源：${describeSource(i.source, i.status)}`,
    '',
    ...CHART_LINK,
  ].join('\n');
}

export interface TargetMessageInput {
  direction: 'above' | 'below';
  price: number;
  targetPrice: number;
  symbol: string;
  currency: string;
  unit: PriceUnit;
  timestamp: Date;
  source: string;
  status: QuoteStatus;
  note: string | null;
}

export function formatTargetMessage(i: TargetMessageInput): string {
  return [
    `${mockFlag(i.status)}🎯 黃金到價提醒`,
    instrumentName(i),
    '',
    `目前價格：${formatPriceWithUnit(i.price, i.currency, i.unit)}`,
    `目標價格：${formatPrice(i.targetPrice)} ${i.currency}（${i.direction === 'above' ? '漲到以上' : '跌到以下'}）`,
    ...(i.note ? [`備註：${i.note}`] : []),
    `報價時間：${formatTaipei(i.timestamp)}`,
    `資料來源：${describeSource(i.source, i.status)}`,
    '這個目標價已自動關閉，需要時請重新設定。',
    '',
    ...CHART_LINK,
  ].join('\n');
}

/** dailyPreview：最新一筆每日快照組成的每日訊息，讓測試推播也能看到實際格式 */
export function formatTestMessage(now: Date, dailyPreview: string | null = null): string {
  const lines = ['✅ Gold Daily 測試推播', `發送時間：${formatTaipei(now)}`, '收到這則訊息代表 LINE 推播設定正確。'];
  if (dailyPreview) {
    lines.push('', '以下是每日行情的格式預覽（最新一筆每日快照，不是即時查價）：', '', dailyPreview);
  }
  return lines.join('\n');
}
