import { z } from 'zod';
import {
  ProviderError,
  type DailyBar,
  type GoldPriceProvider,
  type GoldQuote,
  type HistoryRange,
  type Instrument,
  type ProviderStatus,
} from './types';

// GoldAPI.io（https://www.goldapi.io）
// - 已檢視服務條款（2026-08-21 版）：可在自己的應用程式中使用、處理與顯示資料；
//   不可轉售或轉發 API、不可外流金鑰、不可用多個帳號規避額度。
// - 免費方案（Sandbox）每月最多 100 次請求，更新頻率 2 秒；歷史端點一次最多 90 天。
// - 驗證方式：x-access-token header；金鑰只在伺服器端使用。
// - 2026-10-14 以真實回應確認（見 __fixtures__）：
//   - 最新價回應含 "unit": "troy_ounce"，price 是買價（bid）與賣價（ask）的中價；
//   - 另有 price_per_unit.gram 與 melt_price_per_gram["24k"]，可交叉核對單位；
//   - 歷史端點的週末會沿用週五價格（休市沒有新報價），寫入前要排除週末。

const BASE = 'https://www.goldapi.io';
const TIMEOUT_MS = 10_000;
export const GOLDAPI_FREE_MONTHLY_QUOTA = 100;
const TROY_OUNCE_GRAMS = 31.1034768;

const liveSchema = z.object({
  timestamp: z.number().int().positive(),
  metal: z.string(),
  currency: z.string(),
  price: z.number().finite().positive(),
  symbol: z.string().optional(),
  exchange: z.string().optional(),
  unit: z.string().optional(),
  price_per_unit: z.record(z.string(), z.number()).optional(),
  melt_price_per_gram: z.record(z.string(), z.number()).optional(),
  price_gram_24k: z.number().optional(),
});

const historySchema = z.object({
  metal: z.string(),
  currency: z.string(),
  prices: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), price: z.number().finite().positive() })),
});

export interface GoldApiOptions {
  apiKey: string | undefined;
  /** 本系統使用的商品設定，例如 { symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz' } */
  instrument: Instrument;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** 每金衡盎司報價換算成每公克後，應該接近供應商給的 24K 每公克熔金價 */
export function checkTroyOunceUnit(pricePerOz: number, gram24k: number | undefined): string | null {
  if (gram24k === undefined) return null;
  const ratio = pricePerOz / TROY_OUNCE_GRAMS / gram24k;
  return Math.abs(ratio - 1) <= 0.02 ? null : '報價單位檢查失敗：價格與每公克熔金價不符，可能不是每金衡盎司';
}

function errorFor(status: number, body: { message?: string; error?: string }): ProviderError {
  const detail = body.message ?? body.error ?? '';
  if (status === 401 || status === 403) return new ProviderError(`GoldAPI 金鑰無效或沒有權限（${status}）`, 'http', false);
  // 429 可能是每月額度用完或頻率限制，重試只會繼續失敗並浪費次數
  if (status === 429) return new ProviderError('GoldAPI 回應 429：可能已達每月額度或頻率限制', 'http', false);
  if (status >= 500) return new ProviderError(`GoldAPI 暫時無法服務（${status}）`, 'http', true);
  return new ProviderError(`GoldAPI 回應 ${status}${detail ? `：${detail}` : ''}`, 'http', false);
}

export class GoldApiProvider implements GoldPriceProvider {
  readonly id = 'goldapi';
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly metal: string;

  constructor(private readonly options: GoldApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    // 商品代號例如 XAUUSD → 金屬 XAU、幣別 USD
    this.metal = options.instrument.symbol.slice(0, 3);
  }

  private configIssue(): string | null {
    const { instrument } = this.options;
    if (!this.options.apiKey) return '缺少 GOLD_PRICE_API_KEY。';
    if (this.metal !== 'XAU') return `GOLD_SYMBOL=${instrument.symbol} 不是黃金（應為 XAU 開頭，例如 XAUUSD）。`;
    if (instrument.symbol !== `XAU${instrument.currency}`) return `GOLD_SYMBOL 與 GOLD_CURRENCY 不一致（${instrument.symbol} / ${instrument.currency}）。`;
    if (instrument.unit !== 'troy_oz') return 'GoldAPI 只提供每金衡盎司報價；GOLD_UNIT 請設為 troy_oz（換算公克尚未實作）。';
    return null;
  }

  private async get(path: string): Promise<unknown> {
    const issue = this.configIssue();
    if (issue) throw new ProviderError(issue, 'not_configured');
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        headers: { 'x-access-token': this.options.apiKey!, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderError(timedOut ? 'GoldAPI 逾時' : 'GoldAPI 連線失敗', timedOut ? 'timeout' : 'unavailable', true);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok) throw new ProviderError('GoldAPI 回應不是 JSON', 'invalid_response');
    }
    if (!res.ok) throw errorFor(res.status, (body ?? {}) as { message?: string; error?: string });
    return body;
  }

  async getLatestPrice(): Promise<GoldQuote> {
    const { instrument } = this.options;
    const fetchedAt = this.now();
    const raw = await this.get(`/api/price/${this.metal}/${instrument.currency}?currency_info=false`);
    const parsed = liveSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('GoldAPI 回應格式無法辨識', 'invalid_response');
    const d = parsed.data;
    if (d.metal !== this.metal || d.currency !== instrument.currency) {
      throw new ProviderError(`GoldAPI 回傳的商品不符：${d.metal}/${d.currency}`, 'invalid_response');
    }
    // 單位：回應有明寫就以它為準；再用每公克價格交叉核對（兩者都沒有時只靠下面的合理範圍檢查）
    if (d.unit !== undefined && d.unit !== 'troy_ounce') {
      throw new ProviderError(`GoldAPI 報價單位是 ${d.unit}，不是每金衡盎司，拒絕寫入`, 'invalid_response');
    }
    const gram = d.price_per_unit?.gram ?? d.price_gram_24k ?? Object.entries(d.melt_price_per_gram ?? {}).find(([k]) => /^24/.test(k))?.[1];
    const unitIssue = checkTroyOunceUnit(d.price, gram);
    if (unitIssue) throw new ProviderError(unitIssue, 'invalid_response');
    if (instrument.currency === 'USD' && (d.price < 300 || d.price > 50_000)) {
      throw new ProviderError(`GoldAPI 價格 ${d.price} 不在每金衡盎司的合理範圍，拒絕寫入`, 'invalid_response');
    }
    return {
      ...instrument,
      price: d.price,
      source: this.id,
      timestamp: new Date(d.timestamp * 1000),
      fetchedAt,
      isDelayed: null, // GoldAPI 沒有提供延遲標記
      status: 'valid',
    };
  }

  /** 一次呼叫取得最多 90 天的每日價格（每日價格的定義以 GoldAPI 為準） */
  async getHistoricalPrice(range: HistoryRange): Promise<DailyBar[]> {
    const { instrument } = this.options;
    const toIso = (d: Date) => d.toISOString().slice(0, 10);
    let from = range.from;
    const to = range.to;
    if (to.getTime() - from.getTime() > 89 * 86_400_000) from = new Date(to.getTime() - 89 * 86_400_000);
    const raw = await this.get(`/api/history/${this.metal}/${instrument.currency}?from=${toIso(from)}&to=${toIso(to)}`);
    const parsed = historySchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('GoldAPI 歷史資料格式無法辨識', 'invalid_response');
    if (parsed.data.metal !== this.metal || parsed.data.currency !== instrument.currency) {
      throw new ProviderError('GoldAPI 歷史資料的商品不符', 'invalid_response');
    }
    // 週末休市，GoldAPI 會沿用週五價格補上週六、週日；那不是交易日資料，排除
    return parsed.data.prices
      .filter((p) => {
        const w = new Date(`${p.date}T00:00:00Z`).getUTCDay();
        return w !== 0 && w !== 6;
      })
      .map((p) => ({ date: p.date, price: p.price, timestamp: new Date(`${p.date}T00:00:00Z`) }));
  }

  getProviderStatus(): ProviderStatus {
    const issue = this.configIssue();
    return {
      id: this.id,
      name: 'GoldAPI.io',
      configured: issue === null,
      isMock: false,
      // 依 2026-08-21 版服務條款：個人應用程式中使用與顯示資料屬允許範圍（見 README）
      licensed: issue === null,
      instrument: issue === null ? this.options.instrument : null,
      staleAfterMinutes: 30,
      monthlyCallQuota: GOLDAPI_FREE_MONTHLY_QUOTA,
      notes: issue
        ? [issue]
        : [
            `XAU/${this.options.instrument.currency} 現貨，買賣中價，每金衡盎司（GoldAPI 上游為 FOREXCOM:XAUUSD，Truney 圖表為 OANDA／TradingView，數字可能略有差異）。`,
            '免費方案每月 100 次請求；本系統保留 10 次緩衝並優先保留每日推播。',
          ],
    };
  }
}
