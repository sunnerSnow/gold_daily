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
export type EventStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export type SkipReason =
  | 'line_not_configured'
  | 'quota_unverified'
  | 'quota_insufficient'
  | 'cooldown'
  | 'stale_quote';

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

export type EventPatch = Partial<Pick<EventRow, 'status' | 'skipReason' | 'attemptCount' | 'lastError' | 'sentAt' | 'messageText'>>;

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
  /** 只在目標價仍是 active 時改成 triggered（原子操作）；已被觸發或取消則回傳 null */
  triggerPriceTarget(id: number, fields: { triggeredAt: Date; triggeredPrice: number; triggeredQuoteAt: Date }): Promise<PriceTargetRow | null>;
  updatePriceTarget(id: number, patch: Partial<Pick<PriceTargetRow, 'status' | 'eventId' | 'triggeredAt' | 'triggeredPrice' | 'triggeredQuoteAt'>>): Promise<PriceTargetRow>;

  /** 每次呼叫行情 API 前記一筆，回傳紀錄 id */
  recordProviderCall(input: { provider: string; endpoint: ProviderCallEndpoint; purpose: ProviderCallPurpose; calledAt: Date }): Promise<number>;
  finishProviderCall(id: number, result: { success: boolean; error: string | null }): Promise<void>;
  countProviderCalls(provider: string, since: Date): Promise<number>;
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
