import type { PriceUnit, QuoteStatus } from '../gold/types';
import type { MockScenario } from '../gold/mock-provider';

// 資料存取層的型別。工作流程只依賴這個介面，所以可以換成 Supabase 或記憶體實作。

export interface InstrumentKey {
  source: string;
  symbol: string;
  currency: string;
  unit: PriceUnit;
}

export interface SnapshotRow extends InstrumentKey {
  id: number;
  price: number;
  quoteTimestamp: Date;
  fetchedAt: Date;
  isDelayed: boolean | null;
  status: QuoteStatus;
  dailyDate: string | null;
  createdAt: Date;
}

export type NewSnapshot = Omit<SnapshotRow, 'id' | 'createdAt' | 'dailyDate'>;

export type BaselineMode = 'first_valid_of_day' | 'previous_close' | 'manual';
export type PollingInterval = 0 | 15 | 30 | 60;
/** times = 每天固定時間查價；interval = 固定間隔；off = 不做盤中檢查（只用每日查價） */
export type IntradayMode = 'times' | 'interval' | 'off';

export interface SettingsRow {
  dailyEnabled: boolean;
  /** HH:MM（台北） */
  dailyPushTime: string;
  alertEnabled: boolean;
  riseThresholdPercent: number;
  fallThresholdPercent: number;
  intradayMode: IntradayMode;
  /** 固定時間模式的檢查時間（台北，HH:MM，已排序） */
  checkTimes: string[];
  /** 固定間隔模式的間隔分鐘數 */
  pollingIntervalMinutes: PollingInterval;
  /** 週末（休市）不推播、不查價 */
  skipWeekends: boolean;
  /** 週末不推播時，週六仍送每日推播（週五美國盤的收盤價）；週日照樣不推 */
  saturdayPush: boolean;
  cooldownMinutes: number;
  baselineMode: BaselineMode;
  baselinePrice: number | null;
  baselineTimestamp: Date | null;
  baselineDate: string | null;
  timezone: string;
  linePlan: string;
  monthlyMessageQuota: number;
  quotaSafetyBuffer: number;
  mockScenario: MockScenario;
  createdAt: Date;
  updatedAt: Date;
}

export type SettingsPatch = Partial<Omit<SettingsRow, 'createdAt' | 'updatedAt' | 'timezone'>>;

export type EventType = 'daily' | 'alert_up' | 'alert_down' | 'target' | 'test';
/** LINE 的發送狀態（status 欄位；額度、冷卻等略過原因都記在這裡） */
export type EventStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
/** Telegram 的發送狀態；沒設定 Telegram 時不送，維持 null */
export type TelegramStatus = 'sending' | 'sent' | 'failed';

export type SkipReason =
  | 'line_not_configured'
  | 'quota_unverified'
  | 'quota_insufficient'
  | 'cooldown'
  | 'stale_quote'
  /** 只測試 Telegram 的測試推播：LINE 這一邊本來就不送 */
  | 'not_requested';

export interface EventRow {
  id: number;
  eventType: EventType;
  symbol: string | null;
  currentPrice: number | null;
  baselinePrice: number | null;
  changePercent: number | null;
  thresholdPercent: number | null;
  sourceTimestamp: Date | null;
  idempotencyKey: string;
  lineRetryKey: string;
  messageText: string | null;
  status: EventStatus;
  skipReason: SkipReason | null;
  attemptCount: number;
  lastError: string | null;
  sentAt: Date | null;
  /** null＝沒有送 Telegram（尚未設定，或這則事件不用發送，例如冷卻中） */
  telegramStatus: TelegramStatus | null;
  /** 已送達的 chat ID。Telegram 沒有 retry key，重試時跳過這些聊天室才不會重複 */
  telegramSentTo: string[];
  telegramAttemptCount: number;
  /** 失敗原因；送出後若走勢圖被拒、改送文字，也記在這裡 */
  telegramLastError: string | null;
  telegramSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewEvent = Pick<EventRow, 'eventType' | 'idempotencyKey'> &
  Partial<
    Pick<
      EventRow,
      | 'symbol'
      | 'currentPrice'
      | 'baselinePrice'
      | 'changePercent'
      | 'thresholdPercent'
      | 'sourceTimestamp'
      | 'messageText'
      | 'status'
      | 'skipReason'
    >
  >;

export type EventPatch = Partial<
  Pick<
    EventRow,
    | 'status'
    | 'skipReason'
    | 'attemptCount'
    | 'lastError'
    | 'sentAt'
    | 'messageText'
    | 'telegramStatus'
    | 'telegramSentTo'
    | 'telegramAttemptCount'
    | 'telegramLastError'
    | 'telegramSentAt'
  >
>;

export type JobType = 'daily' | 'intraday' | 'quota_sync';
export type JobTrigger = 'cron' | 'manual';
export type JobStatus = 'running' | 'success' | 'skipped' | 'failed';

export interface JobRunRow {
  id: number;
  jobType: JobType;
  trigger: JobTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  status: JobStatus;
  recordsProcessed: number;
  errorMessage: string | null;
  detail: string | null;
  createdAt: Date;
}

export type JobRunPatch = Partial<Pick<JobRunRow, 'status' | 'recordsProcessed' | 'errorMessage' | 'detail' | 'finishedAt'>>;

export interface JobLockRow {
  jobType: string;
  lockedUntil: Date;
  owner: string;
  lastCalledAt: Date | null;
}

export interface QuotaSyncRow {
  id: number;
  syncedAt: Date;
  success: boolean;
  quotaType: 'none' | 'limited' | null;
  quotaValue: number | null;
  totalUsage: number | null;
  errorMessage: string | null;
}

export type NewQuotaSync = Omit<QuotaSyncRow, 'id'>;

export type TargetDirection = 'above' | 'below';
export type TargetStatus = 'active' | 'triggered' | 'cancelled';

export interface PriceTargetRow extends InstrumentKey {
  id: number;
  direction: TargetDirection;
  targetPrice: number;
  status: TargetStatus;
  note: string | null;
  createdAt: Date;
  triggeredAt: Date | null;
  triggeredPrice: number | null;
  triggeredQuoteAt: Date | null;
  eventId: number | null;
}

export type NewPriceTarget = InstrumentKey & Pick<PriceTargetRow, 'direction' | 'targetPrice' | 'note'>;

export type ProviderCallEndpoint = 'latest' | 'history' | 'stat';
export type ProviderCallPurpose = 'daily' | 'check' | 'manual' | 'backfill' | 'reference' | 'stat';

/** active＝會收到推播；stopped＝傳了 /stop 或被管理者移除；blocked＝封鎖了 bot */
export type TelegramSubscriberStatus = 'active' | 'stopped' | 'blocked';

export interface TelegramSubscriberRow {
  chatId: string;
  /** 後台顯示用的名字與 @username（使用者在 Telegram 上公開的資料） */
  name: string | null;
  username: string | null;
  status: TelegramSubscriberStatus;
  /** 最近一次訂閱的時間 */
  subscribedAt: Date;
  updatedAt: Date;
}

export interface DailySnapshotQuery {
  instrument?: Pick<InstrumentKey, 'source' | 'symbol'>;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface Store {
  readonly kind: 'supabase' | 'memory';

  /** 依 (source, symbol, quote_timestamp) 去重；已存在時回傳既有那筆 */
  insertSnapshot(input: NewSnapshot): Promise<{ snapshot: SnapshotRow; created: boolean }>;
  /** 把某筆快照標成某天的每日快照；那天已有每日快照時回傳 false */
  markDailySnapshot(id: number, dailyDate: string): Promise<boolean>;
  getDailySnapshot(instrument: InstrumentKey, dailyDate: string): Promise<SnapshotRow | null>;
  /** 指定日期之前最近的一筆每日快照（前一交易日的有效參考價） */
  getPreviousDailySnapshot(instrument: InstrumentKey, beforeDate: string): Promise<SnapshotRow | null>;
  /** 某時刻之後最早的一筆快照（當日首筆有效報價） */
  getFirstSnapshotSince(instrument: InstrumentKey, since: Date): Promise<SnapshotRow | null>;
  getLatestSnapshot(instrument: Pick<InstrumentKey, 'source' | 'symbol'>): Promise<SnapshotRow | null>;
  listDailySnapshots(query: DailySnapshotQuery): Promise<{ rows: SnapshotRow[]; total: number }>;

  getSettings(): Promise<SettingsRow>;
  updateSettings(patch: SettingsPatch): Promise<SettingsRow>;

  /** 依 idempotency_key 去重；已存在時回傳既有事件 */
  insertEvent(input: NewEvent): Promise<{ event: EventRow; created: boolean }>;
  updateEvent(id: number, patch: EventPatch): Promise<EventRow>;
  getEvent(id: number): Promise<EventRow | null>;
  getEventByKey(idempotencyKey: string): Promise<EventRow | null>;
  getLastEvent(types: EventType[], statuses: EventStatus[], since?: Date): Promise<EventRow | null>;
  listEvents(options: { types?: EventType[]; limit: number }): Promise<EventRow[]>;
  countSentSince(since: Date): Promise<number>;

  startJobRun(jobType: JobType, trigger: JobTrigger): Promise<JobRunRow>;
  finishJobRun(id: number, patch: JobRunPatch): Promise<JobRunRow>;
  listJobRuns(options: { jobType?: JobType; status?: JobStatus; limit: number }): Promise<JobRunRow[]>;
  getLastJobRun(jobType: JobType, statuses?: JobStatus[]): Promise<JobRunRow | null>;

  tryAcquireLock(jobType: string, owner: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(jobType: string, owner: string): Promise<void>;
  /** 記錄排程被呼叫的時間（不論這次有沒有真的執行），系統狀態頁用來判斷排程是否正常 */
  recordCronCall(jobType: string, at: Date): Promise<void>;
  getLocks(): Promise<JobLockRow[]>;

  insertQuotaSync(input: NewQuotaSync): Promise<QuotaSyncRow>;
  getLatestQuotaSync(options?: { successOnly?: boolean }): Promise<QuotaSyncRow | null>;

  insertPriceTarget(input: NewPriceTarget): Promise<PriceTargetRow>;
  listPriceTargets(options: { statuses?: TargetStatus[]; limit: number }): Promise<PriceTargetRow[]>;
  /**
   * 只在目標價仍是 active 時改成 triggered（原子操作）；已被觸發或取消則回傳 null。
   * 已經有通知它的事件時（例如併入每日推播）一併寫入 eventId，關閉與指向事件在同一次更新完成。
   */
  triggerPriceTarget(
    id: number,
    fields: { triggeredAt: Date; triggeredPrice: number; triggeredQuoteAt: Date; eventId?: number },
  ): Promise<PriceTargetRow | null>;
  updatePriceTarget(id: number, patch: Partial<Pick<PriceTargetRow, 'status' | 'eventId' | 'triggeredAt' | 'triggeredPrice' | 'triggeredQuoteAt'>>): Promise<PriceTargetRow>;

  /** 每次呼叫行情 API 前記一筆，回傳紀錄 id */
  recordProviderCall(input: { provider: string; endpoint: ProviderCallEndpoint; purpose: ProviderCallPurpose; calledAt: Date }): Promise<number>;
  finishProviderCall(id: number, result: { success: boolean; error: string | null }): Promise<void>;
  countProviderCalls(provider: string, since: Date): Promise<number>;

  /** 訂閱 Telegram（已存在就改回 active、更新名字）；alreadyActive 表示原本就在訂閱中 */
  subscribeTelegram(input: { chatId: string; name: string | null; username: string | null }): Promise<{ subscriber: TelegramSubscriberRow; alreadyActive: boolean }>;
  getTelegramSubscriber(chatId: string): Promise<TelegramSubscriberRow | null>;
  /** 改變訂閱狀態；找不到這個聊天室時回傳 null */
  setTelegramSubscriberStatus(chatId: string, status: TelegramSubscriberStatus): Promise<TelegramSubscriberRow | null>;
  /** 依最近訂閱時間由新到舊 */
  listTelegramSubscribers(options: { statuses?: TelegramSubscriberStatus[]; limit: number }): Promise<TelegramSubscriberRow[]>;
}

export const DEFAULT_SETTINGS: Omit<SettingsRow, 'createdAt' | 'updatedAt'> = {
  dailyEnabled: true,
  dailyPushTime: '09:00',
  alertEnabled: true,
  riseThresholdPercent: 1,
  fallThresholdPercent: 1,
  intradayMode: 'times',
  checkTimes: ['21:30'],
  pollingIntervalMinutes: 15,
  skipWeekends: true,
  saturdayPush: true,
  cooldownMinutes: 240,
  baselineMode: 'first_valid_of_day',
  baselinePrice: null,
  baselineTimestamp: null,
  baselineDate: null,
  timezone: 'Asia/Taipei',
  linePlan: 'light_free',
  monthlyMessageQuota: 200,
  quotaSafetyBuffer: 5,
  mockScenario: 'normal',
};
