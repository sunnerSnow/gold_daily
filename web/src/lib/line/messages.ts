import { formatPercent, formatPrice, formatSigned } from '../gold/math';
import { UNIT_LABEL, type PriceUnit, type QuoteStatus } from '../gold/types';
import { formatTaipei } from '../time';

// 推播訊息格式。所有數字都來自實際資料；沒有資料時顯示「無資料」，不填假數字。

export const REFERENCE_CHART_URL = 'https://www.truney.com/gold-chart';

export interface DataStatusInput {
  status: QuoteStatus;
  stale: boolean;
}

const SOURCE_NAMES: Record<string, string> = { goldapi: 'GoldAPI.io' };

export function describeSource(source: string, status: QuoteStatus): string {
  if (status === 'mock') return 'Mock Provider（模擬資料，非真實行情）';
  return SOURCE_NAMES[source] ?? source;
}

export function describeDataStatus({ status, stale }: DataStatusInput): string {
  const base = stale ? '過期（行情來源未更新）' : status === 'delayed' ? '有效（延遲報價）' : '有效';
  return status === 'mock' ? `${base}（模擬）` : base;
}

const mockFlag = (status: QuoteStatus) => (status === 'mock' ? '【模擬資料】' : '');

export interface DailyMessageInput {
  price: number;
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
  return [
    `${mockFlag(i.status)}黃金每日行情`,
    '',
    `報價：${formatPrice(i.price)} ${i.currency}/${UNIT_LABEL[i.unit]}`,
    `前一交易日：${i.referencePrice === null ? '無資料' : formatPrice(i.referencePrice)}`,
    `漲跌：${i.changeAmount === null ? '無法計算' : formatSigned(i.changeAmount)}`,
    `漲跌幅：${i.changePercent === null ? '無法計算' : formatPercent(i.changePercent)}`,
    `報價時間：${formatTaipei(i.timestamp)}`,
    `資料來源：${describeSource(i.source, i.status)}`,
    `資料狀態：${describeDataStatus(i)}`,
    '',
    '參考圖表：',
    REFERENCE_CHART_URL,
  ].join('\n');
}

export interface AlertMessageInput {
  direction: 'up' | 'down';
  price: number;
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
    `${mockFlag(i.status)}黃金價格異動提醒`,
    '',
    `目前價格：${formatPrice(i.price)} ${i.currency}/${UNIT_LABEL[i.unit]}`,
    `參考價格：${formatPrice(i.baselinePrice)}`,
    `價格變化：${formatPercent(i.changePercent)}`,
    `觸發條件：${condition}`,
    `觸發時間：${formatTaipei(i.timestamp)}`,
    `資料來源：${describeSource(i.source, i.status)}`,
    '',
    '參考圖表：',
    REFERENCE_CHART_URL,
  ].join('\n');
}

export interface TargetMessageInput {
  direction: 'above' | 'below';
  price: number;
  targetPrice: number;
  currency: string;
  unit: PriceUnit;
  timestamp: Date;
  source: string;
  status: QuoteStatus;
  note: string | null;
}

export function formatTargetMessage(i: TargetMessageInput): string {
  return [
    `${mockFlag(i.status)}黃金到價提醒`,
    '',
    `目前價格：${formatPrice(i.price)} ${i.currency}/${UNIT_LABEL[i.unit]}`,
    `目標價格：${formatPrice(i.targetPrice)}（${i.direction === 'above' ? '漲到以上' : '跌到以下'}）`,
    ...(i.note ? [`備註：${i.note}`] : []),
    `報價時間：${formatTaipei(i.timestamp)}`,
    `資料來源：${describeSource(i.source, i.status)}`,
    '這個目標價已自動關閉，需要時請重新設定。',
    '',
    '參考圖表：',
    REFERENCE_CHART_URL,
  ].join('\n');
}

export function formatTestMessage(now: Date): string {
  return ['Gold Daily 測試推播', '', `發送時間：${formatTaipei(now)}`, '收到這則訊息代表 LINE 推播設定正確。'].join('\n');
}
