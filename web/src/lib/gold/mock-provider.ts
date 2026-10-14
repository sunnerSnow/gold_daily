import { taipeiDate, taipeiParts } from '../time';
import {
  ProviderError,
  type DailyBar,
  type GoldPriceProvider,
  type GoldQuote,
  type HistoryRange,
  type Instrument,
  type ProviderStatus,
} from './types';

// Mock Provider：只給開發與測試用。所有報價的 status 都是 'mock'、symbol 帶 MOCK: 前綴，
// 畫面與推播都會依此標示「模擬資料」。價格是依時間決定的假隨機漫步，同一分鐘呼叫多次會拿到同一筆。

export type MockScenario = 'normal' | 'surge' | 'plunge' | 'stale' | 'error';

export const MOCK_SCENARIOS: { value: MockScenario; label: string }[] = [
  { value: 'normal', label: '正常波動' },
  { value: 'surge', label: '急漲（比正常價高 1.5%）' },
  { value: 'plunge', label: '急跌（比正常價低 1.5%）' },
  { value: 'stale', label: '來源未更新（報價停在 3 小時前）' },
  { value: 'error', label: '來源中斷（呼叫失敗）' },
];

export const MOCK_INSTRUMENT: Instrument = { symbol: 'MOCK:XAUUSD', currency: 'USD', unit: 'troy_oz' };

const ANCHOR_DATE = '2026-01-01';
const ANCHOR_LEVEL = 3800;
const DAY_MS = 86_400_000;

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 由字串決定的 0–1 假亂數 */
function rand(key: string): number {
  let t = (hashString(key) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function isWeekday(isoDate: string): boolean {
  const w = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6;
}

const levelCache = new Map<string, number>();

/** 某個台北日期的基準價（只有平日會變動） */
function levelOn(isoDate: string): number {
  const cached = levelCache.get(isoDate);
  if (cached !== undefined) return cached;
  let level = ANCHOR_LEVEL;
  const start = Date.parse(`${ANCHOR_DATE}T00:00:00Z`);
  const end = Date.parse(`${isoDate}T00:00:00Z`);
  const step = end >= start ? DAY_MS : -DAY_MS;
  for (let t = start; step > 0 ? t < end : t > end; t += step) {
    const day = new Date(step > 0 ? t + DAY_MS : t).toISOString().slice(0, 10);
    if (!isWeekday(day)) continue;
    const r = (rand(`day:${day}`) - 0.47) * 0.016;
    level = step > 0 ? level * (1 + r) : level / (1 + r);
  }
  levelCache.set(isoDate, level);
  return level;
}

/** 金市在台北時間週六 05:00 到週一 06:00 休市 */
function lastOpenInstant(now: Date): Date {
  const p = taipeiParts(now);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const minutes = p.hour * 60 + p.minute;
  const closedSat = weekday === 6 && minutes >= 5 * 60;
  const closedSun = weekday === 0;
  const closedMon = weekday === 1 && minutes < 6 * 60;
  if (!closedSat && !closedSun && !closedMon) return now;
  // 退回到週六 05:00（台北）= 週五 21:00 UTC
  const back = closedSat ? 0 : closedSun ? 1 : 2;
  const sat = Date.UTC(p.year, p.month - 1, p.day - back);
  return new Date(sat - 8 * 3600_000 + 5 * 3600_000 - 60_000);
}

function priceAt(instant: Date): number {
  const day = taipeiDate(instant);
  const bucket = Math.floor(instant.getTime() / (15 * 60_000));
  const noise = (rand(`q:${bucket}`) - 0.5) * 0.003;
  return Math.round(levelOn(day) * (1 + noise) * 100) / 100;
}

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export interface MockProviderOptions {
  scenario?: MockScenario;
  now?: () => Date;
  /** 只供本機測試查價次數保護：模擬的每月上限（預設沒有上限） */
  monthlyQuota?: number | null;
}

export class MockGoldPriceProvider implements GoldPriceProvider {
  readonly id = 'mock';
  private readonly scenario: MockScenario;
  private readonly now: () => Date;
  private readonly monthlyQuota: number | null;

  constructor(options: MockProviderOptions = {}) {
    this.scenario = options.scenario ?? 'normal';
    this.now = options.now ?? (() => new Date());
    this.monthlyQuota = options.monthlyQuota ?? null;
  }

  async getLatestPrice(): Promise<GoldQuote> {
    const fetchedAt = this.now();
    if (this.scenario === 'error') {
      throw new ProviderError('Mock Provider：模擬行情來源中斷', 'unavailable', true);
    }
    let timestamp = floorToMinute(lastOpenInstant(fetchedAt));
    if (this.scenario === 'stale') timestamp = new Date(timestamp.getTime() - 3 * 3600_000);
    let price = priceAt(timestamp);
    if (this.scenario === 'surge') price = Math.round(price * 1.015 * 100) / 100;
    if (this.scenario === 'plunge') price = Math.round(price * 0.985 * 100) / 100;
    return {
      ...MOCK_INSTRUMENT,
      price,
      source: 'mock',
      timestamp,
      fetchedAt,
      isDelayed: null,
      status: 'mock',
    };
  }

  /** 每個平日一筆，價格取該日台北 09:00 的模擬價 */
  async getHistoricalPrice(range: HistoryRange): Promise<DailyBar[]> {
    if (this.scenario === 'error') {
      throw new ProviderError('Mock Provider：模擬行情來源中斷', 'unavailable', true);
    }
    const bars: DailyBar[] = [];
    const from = taipeiDate(range.from);
    const to = taipeiDate(range.to);
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (!isWeekday(date)) continue;
      const timestamp = new Date(Date.parse(`${date}T01:00:00Z`)); // 台北 09:00
      if (timestamp > this.now()) continue;
      bars.push({ date, price: priceAt(timestamp), timestamp });
    }
    return bars;
  }

  getProviderStatus(): ProviderStatus {
    return {
      id: this.id,
      name: 'Mock Provider',
      configured: true,
      isMock: true,
      licensed: false,
      instrument: MOCK_INSTRUMENT,
      staleAfterMinutes: 30,
      monthlyCallQuota: this.monthlyQuota,
      notes: [
        '模擬資料，只供開發與測試，不代表真實行情。',
        `目前情境：${MOCK_SCENARIOS.find((s) => s.value === this.scenario)?.label ?? this.scenario}`,
      ],
    };
  }
}
