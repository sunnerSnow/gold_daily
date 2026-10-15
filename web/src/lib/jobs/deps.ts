import type { GoldPriceProvider } from '../gold/types';
import type { LineClient } from '../line/client';
import type { Store } from '../store/types';

// 排程工作需要的外部依賴。正式環境由 server.ts 組裝，測試傳入假的實作。

export interface JobDeps {
  store: Store;
  provider: GoldPriceProvider;
  line: LineClient;
  now: () => Date;
  /** 重試間隔；測試時換成不等待 */
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  /** 網站對外的 https 網址（每日推播附走勢圖用）；沒有時只送文字 */
  appUrl?: string | null;
}

export type JobOutcomeStatus = 'not_due' | 'disabled' | 'locked' | 'success' | 'skipped' | 'failed';

export interface JobOutcome {
  status: JobOutcomeStatus;
  detail: string;
  jobRunId?: number;
  eventIds?: number[];
}

/** 把錯誤轉成可以寫進資料庫、顯示在畫面的簡短訊息（不含堆疊與秘密） */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
    return msg || err.name;
  }
  return '未知錯誤';
}
