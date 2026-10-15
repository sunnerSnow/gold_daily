import { formatPercent, formatPrice, formatSigned, round } from '../gold/math';
import { UNIT_LABEL, type PriceUnit, type QuoteStatus } from '../gold/types';
import { formatDateLabel, formatTaipei, formatTaipeiHour, taipeiDate } from '../time';

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

export const DAILY_TITLE = '💰黃金每日行情';

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

/** 每日訊息的欄位（純文字與卡片共用，數字只算一次） */
export interface DailyFields {
  valid: boolean;
  title: string;
  /** 2026/10/15（四）：報價時間戳換算成的台北日期（Intl 換算，不手動加 8 小時） */
  date: string | null;
  instrument: string;
  price: string;
  unit: string;
  /** ▼ −21.83 USD（−0.52%）；沒有前一交易日時為 null */
  change: string | null;
  tone: Direction | null;
  rows: [label: string, value: string][];
  /** 過期或異常（畫面與卡片要醒目標示） */
  warning: boolean;
}

export function dailyFields(i: DailyMessageInput): DailyFields {
  const validTime = !Number.isNaN(i.timestamp.getTime());
  const title = `${mockFlag(i.status)}${DAILY_TITLE}`;
  const date = validTime ? formatDateLabel(taipeiDate(i.timestamp)) : null;
  const source: [string, string] = ['資料來源', describeSource(i.source, i.status)];
  if (!isValidPrice(i.price) || !validTime) {
    return { valid: false, title, date, instrument: '', price: NO_DATA, unit: '', change: null, tone: null, rows: [source, ['資料狀態', '異常（報價無效）']], warning: true };
  }
  const hasChange = isValidPrice(i.referencePrice) && isFiniteNumber(i.changeAmount) && isFiniteNumber(i.changePercent);
  return {
    valid: true,
    title,
    date,
    instrument: instrumentName(i),
    price: formatPrice(i.price),
    unit: `${i.currency} / ${UNIT_LABEL[i.unit]}`,
    change: hasChange ? formatChangeLine(i.changeAmount!, i.changePercent!, i.currency) : null,
    tone: hasChange ? changeDirection(i.changeAmount!) : null,
    rows: [
      ['前一交易日', isValidPrice(i.referencePrice) ? `${formatPrice(i.referencePrice)} ${i.currency}` : NO_DATA],
      ['報價時間', formatTaipeiHour(i.timestamp)],
      source,
      ['資料狀態', describeDataStatus(i)],
    ],
    warning: i.stale,
  };
}

export function formatDailyMessage(i: DailyMessageInput): string {
  const f = dailyFields(i);
  const lines = [f.title, ...(f.date ? [f.date] : []), ''];
  if (!f.valid) {
    lines.push(f.price);
  } else {
    lines.push(f.instrument, `${f.price} ${f.unit}`);
    if (f.change) lines.push('', f.change);
  }
  lines.push('', ...f.rows.map(([label, value]) => `${label}：${value}`), '', ...CHART_LINK);
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

/** withCard：後面會接著一張每日行情卡片（最新一筆每日快照），讓測試推播也能看到實際樣子 */
export function formatTestMessage(now: Date, withCard = false): string {
  const lines = ['✅ Gold Daily 測試推播', `發送時間：${formatTaipei(now)}`, '收到這則訊息代表 LINE 推播設定正確。'];
  if (withCard) lines.push('', '下面是每日行情卡片的預覽（最新一筆每日快照，不是即時查價）。');
  return lines.join('\n');
}
