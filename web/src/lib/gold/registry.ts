import { GoldApiProvider } from './goldapi-provider';
import { MockGoldPriceProvider, type MockScenario } from './mock-provider';
import { ProviderError, type GoldPriceProvider, type PriceUnit, type ProviderStatus } from './types';

// 依 GOLD_PRICE_PROVIDER 建立 Provider。只有確認過授權並驗證過回應格式的來源才會列在這裡；
// 未知或空白的設定一律回傳「尚未設定正式行情來源」，不會偷偷改用 Mock。

export interface ProviderConfig {
  providerId: string | undefined;
  apiKey?: string;
  symbol?: string;
  currency?: string;
  unit?: string;
  mockScenario?: MockScenario;
  mockMonthlyQuota?: number | null;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

class UnconfiguredProvider implements GoldPriceProvider {
  readonly id = 'unconfigured';
  constructor(private readonly requested: string | undefined) {}

  async getLatestPrice(): Promise<never> {
    throw new ProviderError('尚未設定正式行情來源', 'not_configured');
  }

  async getHistoricalPrice(): Promise<never> {
    throw new ProviderError('尚未設定正式行情來源', 'not_configured');
  }

  getProviderStatus(): ProviderStatus {
    return {
      id: this.id,
      name: '尚未設定正式行情來源',
      configured: false,
      isMock: false,
      licensed: false,
      instrument: null,
      staleAfterMinutes: 30,
      monthlyCallQuota: null,
      notes: this.requested
        ? [`GOLD_PRICE_PROVIDER=${this.requested} 不是已支援的行情來源（目前支援 goldapi、mock）。`]
        : ['GOLD_PRICE_PROVIDER 沒有設定。正式使用設為 goldapi；開發時可設為 mock。'],
    };
  }
}

export function createProvider(config: ProviderConfig): GoldPriceProvider {
  const id = config.providerId?.trim().toLowerCase();
  if (id === 'mock') {
    return new MockGoldPriceProvider({ scenario: config.mockScenario, now: config.now, monthlyQuota: config.mockMonthlyQuota });
  }
  if (id === 'goldapi') {
    return new GoldApiProvider({
      apiKey: config.apiKey,
      instrument: {
        symbol: (config.symbol ?? 'XAUUSD').toUpperCase(),
        currency: (config.currency ?? 'USD').toUpperCase(),
        unit: (config.unit ?? 'troy_oz') as PriceUnit,
      },
      fetchImpl: config.fetchImpl,
      now: config.now,
    });
  }
  return new UnconfiguredProvider(id || undefined);
}
