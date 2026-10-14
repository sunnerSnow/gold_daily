// 行情來源模組的共用型別。所有 Provider 都要回傳同一個形狀，方便替換。

/** 報價單位：金衡盎司或公克。不同單位不可混算。 */
export type PriceUnit = 'troy_oz' | 'gram';

/**
 * 報價本身的狀態（由 Provider 決定）：
 * - valid：正式來源的即時報價
 * - delayed：正式來源，但供應商標示為延遲報價
 * - mock：Mock Provider 產生的模擬資料，絕不能當成真實行情
 */
export type QuoteStatus = 'valid' | 'delayed' | 'mock';

export interface Instrument {
  symbol: string;
  currency: string;
  unit: PriceUnit;
}

export interface GoldQuote extends Instrument {
  price: number;
  source: string;
  /** 供應商的報價時間 */
  timestamp: Date;
  /** 本系統取得報價的時間 */
  fetchedAt: Date;
  /** 供應商有提供才填；null 代表「供應商未提供」 */
  isDelayed: boolean | null;
  status: QuoteStatus;
}

/** 一天一筆的歷史收盤（或供應商定義的每日價格） */
export interface DailyBar {
  /** 交易日（供應商定義），YYYY-MM-DD */
  date: string;
  price: number;
  timestamp: Date;
}

export interface ProviderStatus {
  /** 例如 mock、goldapi；未設定時為 unconfigured */
  id: string;
  name: string;
  /** 已完成設定、可以呼叫 */
  configured: boolean;
  isMock: boolean;
  /** 是否已確認授權與使用條款。Mock 與未設定都是 false。 */
  licensed: boolean;
  instrument: Instrument | null;
  /** 報價超過這個分鐘數視為過期 */
  staleAfterMinutes: number;
  /** 供應商每月請求上限；null = 沒有上限（Mock） */
  monthlyCallQuota: number | null;
  /** 給畫面顯示的說明（不含任何金鑰） */
  notes: string[];
}

export interface HistoryRange {
  from: Date;
  to: Date;
}

export interface GoldPriceProvider {
  readonly id: string;
  getLatestPrice(): Promise<GoldQuote>;
  getHistoricalPrice(range: HistoryRange): Promise<DailyBar[]>;
  getProviderStatus(): ProviderStatus;
}

/** Provider 呼叫失敗時拋出這個錯誤；絕不回傳預設價格。 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'timeout' | 'http' | 'invalid_response' | 'unavailable',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const UNIT_LABEL: Record<PriceUnit, string> = {
  troy_oz: '金衡盎司',
  gram: '公克',
};
