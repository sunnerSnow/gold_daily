import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type DailySnapshotQuery,
  type EventPatch,
  type EventRow,
  type EventStatus,
  type EventType,
  type InstrumentKey,
  type JobLockRow,
  type JobRunPatch,
  type JobRunRow,
  type JobStatus,
  type JobTrigger,
  type JobType,
  type NewEvent,
  type NewQuotaSync,
  type NewPriceTarget,
  type NewSnapshot,
  type PriceTargetRow,
  type ProviderCallEndpoint,
  type ProviderCallPurpose,
  type QuotaSyncRow,
  type SettingsPatch,
  type SettingsRow,
  type SnapshotRow,
  type Store,
  type TargetStatus,
} from './types';

// 記憶體實作：測試與「沒有 Supabase 的本機開發」用。資料只存在目前的 Node 行程裡，重啟就清空。
// 行為（去重、唯一索引、鎖）要跟 Supabase 版一致，測試才有意義。

const sameKey = (a: InstrumentKey, b: InstrumentKey) =>
  a.source === b.source && a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit;

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private snapshots: SnapshotRow[] = [];
  private events: EventRow[] = [];
  private jobRuns: JobRunRow[] = [];
  private locks = new Map<string, JobLockRow>();
  private quotaSyncs: QuotaSyncRow[] = [];
  private targets: PriceTargetRow[] = [];
  private providerCalls: {
    id: number;
    provider: string;
    endpoint: ProviderCallEndpoint;
    purpose: ProviderCallPurpose;
    calledAt: Date;
    success: boolean | null;
    error: string | null;
  }[] = [];
  private settings: SettingsRow;
  private seq = { snapshot: 0, event: 0, job: 0, quota: 0, target: 0, call: 0 };

  constructor(private readonly now: () => Date = () => new Date()) {
    const t = this.now();
    this.settings = { ...DEFAULT_SETTINGS, checkTimes: [...DEFAULT_SETTINGS.checkTimes], createdAt: t, updatedAt: t };
  }

  async insertSnapshot(input: NewSnapshot) {
    const existing = this.snapshots.find(
      (s) => s.source === input.source && s.symbol === input.symbol && s.quoteTimestamp.getTime() === input.quoteTimestamp.getTime(),
    );
    if (existing) return { snapshot: { ...existing }, created: false };
    const row: SnapshotRow = { ...input, id: ++this.seq.snapshot, dailyDate: null, createdAt: this.now() };
    this.snapshots.push(row);
    return { snapshot: { ...row }, created: true };
  }

  async markDailySnapshot(id: number, dailyDate: string) {
    const row = this.snapshots.find((s) => s.id === id);
    if (!row) return false;
    if (row.dailyDate === dailyDate) return true;
    const taken = this.snapshots.some(
      (s) => s.id !== id && s.source === row.source && s.symbol === row.symbol && s.dailyDate === dailyDate,
    );
    if (taken || row.dailyDate) return false;
    row.dailyDate = dailyDate;
    return true;
  }

  async getDailySnapshot(instrument: InstrumentKey, dailyDate: string) {
    const row = this.snapshots.find((s) => sameKey(s, instrument) && s.dailyDate === dailyDate);
    return row ? { ...row } : null;
  }

  async getPreviousDailySnapshot(instrument: InstrumentKey, beforeDate: string) {
    const rows = this.snapshots
      .filter((s) => sameKey(s, instrument) && s.dailyDate !== null && s.dailyDate < beforeDate)
      .sort((a, b) => (a.dailyDate! < b.dailyDate! ? 1 : -1));
    return rows[0] ? { ...rows[0] } : null;
  }

  async getFirstSnapshotSince(instrument: InstrumentKey, since: Date) {
    const rows = this.snapshots
      .filter((s) => sameKey(s, instrument) && s.quoteTimestamp >= since)
      .sort((a, b) => a.quoteTimestamp.getTime() - b.quoteTimestamp.getTime());
    return rows[0] ? { ...rows[0] } : null;
  }

  async getLatestSnapshot(instrument: Pick<InstrumentKey, 'source' | 'symbol'>) {
    const rows = this.snapshots
      .filter((s) => s.source === instrument.source && s.symbol === instrument.symbol)
      .sort((a, b) => b.quoteTimestamp.getTime() - a.quoteTimestamp.getTime());
    return rows[0] ? { ...rows[0] } : null;
  }

  async listDailySnapshots(query: DailySnapshotQuery) {
    const rows = this.snapshots
      .filter((s) => s.dailyDate !== null)
      .filter((s) => !query.instrument || (s.source === query.instrument.source && s.symbol === query.instrument.symbol))
      .filter((s) => !query.from || s.dailyDate! >= query.from)
      .filter((s) => !query.to || s.dailyDate! <= query.to)
      .sort((a, b) => (a.dailyDate! < b.dailyDate! ? 1 : -1));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? rows.length;
    return { rows: rows.slice(offset, offset + limit).map((r) => ({ ...r })), total: rows.length };
  }

  async getSettings() {
    return { ...this.settings };
  }

  async updateSettings(patch: SettingsPatch) {
    this.settings = { ...this.settings, ...patch, updatedAt: this.now() };
    return { ...this.settings };
  }

  async insertEvent(input: NewEvent) {
    const existing = this.events.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (existing) return { event: { ...existing }, created: false };
    const t = this.now();
    const row: EventRow = {
      id: ++this.seq.event,
      eventType: input.eventType,
      symbol: input.symbol ?? null,
      currentPrice: input.currentPrice ?? null,
      baselinePrice: input.baselinePrice ?? null,
      changePercent: input.changePercent ?? null,
      thresholdPercent: input.thresholdPercent ?? null,
      sourceTimestamp: input.sourceTimestamp ?? null,
      idempotencyKey: input.idempotencyKey,
      lineRetryKey: randomUUID(),
      messageText: input.messageText ?? null,
      status: input.status ?? 'pending',
      skipReason: input.skipReason ?? null,
      attemptCount: 0,
      lastError: null,
      sentAt: null,
      createdAt: t,
      updatedAt: t,
    };
    this.events.push(row);
    return { event: { ...row }, created: true };
  }

  async updateEvent(id: number, patch: EventPatch) {
    const row = this.events.find((e) => e.id === id);
    if (!row) throw new Error(`event ${id} not found`);
    Object.assign(row, patch, { updatedAt: this.now() });
    return { ...row };
  }

  async getEvent(id: number) {
    const row = this.events.find((e) => e.id === id);
    return row ? { ...row } : null;
  }

  async getEventByKey(idempotencyKey: string) {
    const row = this.events.find((e) => e.idempotencyKey === idempotencyKey);
    return row ? { ...row } : null;
  }

  async getLastEvent(types: EventType[], statuses: EventStatus[], since?: Date) {
    const rows = this.events
      .filter((e) => types.includes(e.eventType) && statuses.includes(e.status))
      .filter((e) => !since || e.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    return rows[0] ? { ...rows[0] } : null;
  }

  async listEvents(options: { types?: EventType[]; limit: number }) {
    return this.events
      .filter((e) => !options.types || options.types.includes(e.eventType))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .slice(0, options.limit)
      .map((e) => ({ ...e }));
  }

  async countSentSince(since: Date) {
    return this.events.filter((e) => e.status === 'sent' && e.sentAt && e.sentAt >= since).length;
  }

  async startJobRun(jobType: JobType, trigger: JobTrigger) {
    const t = this.now();
    const row: JobRunRow = {
      id: ++this.seq.job,
      jobType,
      trigger,
      startedAt: t,
      finishedAt: null,
      status: 'running',
      recordsProcessed: 0,
      errorMessage: null,
      detail: null,
      createdAt: t,
    };
    this.jobRuns.push(row);
    return { ...row };
  }

  async finishJobRun(id: number, patch: JobRunPatch) {
    const row = this.jobRuns.find((j) => j.id === id);
    if (!row) throw new Error(`job run ${id} not found`);
    Object.assign(row, { finishedAt: this.now() }, patch);
    return { ...row };
  }

  async listJobRuns(options: { jobType?: JobType; status?: JobStatus; limit: number }) {
    return this.jobRuns
      .filter((j) => !options.jobType || j.jobType === options.jobType)
      .filter((j) => !options.status || j.status === options.status)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id - a.id)
      .slice(0, options.limit)
      .map((j) => ({ ...j }));
  }

  async getLastJobRun(jobType: JobType, statuses?: JobStatus[]) {
    const rows = this.jobRuns
      .filter((j) => j.jobType === jobType && (!statuses || statuses.includes(j.status)))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id - a.id);
    return rows[0] ? { ...rows[0] } : null;
  }

  async tryAcquireLock(jobType: string, owner: string, ttlSeconds: number) {
    const t = this.now();
    const current = this.locks.get(jobType);
    if (current && current.lockedUntil > t) {
      current.lastCalledAt = t;
      return false;
    }
    this.locks.set(jobType, { jobType, owner, lockedUntil: new Date(t.getTime() + ttlSeconds * 1000), lastCalledAt: t });
    return true;
  }

  async releaseLock(jobType: string, owner: string) {
    const current = this.locks.get(jobType);
    if (current && current.owner === owner) current.lockedUntil = this.now();
  }

  async recordCronCall(jobType: string, at: Date) {
    const current = this.locks.get(jobType);
    if (current) current.lastCalledAt = at;
    else this.locks.set(jobType, { jobType, owner: '', lockedUntil: new Date(0), lastCalledAt: at });
  }

  async getLocks() {
    return [...this.locks.values()].map((l) => ({ ...l }));
  }

  async insertQuotaSync(input: NewQuotaSync) {
    const row: QuotaSyncRow = { ...input, id: ++this.seq.quota };
    this.quotaSyncs.push(row);
    return { ...row };
  }

  async getLatestQuotaSync(options?: { successOnly?: boolean }) {
    const rows = this.quotaSyncs
      .filter((q) => !options?.successOnly || q.success)
      .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime() || b.id - a.id);
    return rows[0] ? { ...rows[0] } : null;
  }

  async insertPriceTarget(input: NewPriceTarget) {
    const row: PriceTargetRow = {
      ...input,
      id: ++this.seq.target,
      status: 'active',
      createdAt: this.now(),
      triggeredAt: null,
      triggeredPrice: null,
      triggeredQuoteAt: null,
      eventId: null,
    };
    this.targets.push(row);
    return { ...row };
  }

  async listPriceTargets(options: { statuses?: TargetStatus[]; limit: number }) {
    return this.targets
      .filter((t) => !options.statuses || options.statuses.includes(t.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .slice(0, options.limit)
      .map((t) => ({ ...t }));
  }

  async triggerPriceTarget(id: number, fields: { triggeredAt: Date; triggeredPrice: number; triggeredQuoteAt: Date }) {
    const row = this.targets.find((t) => t.id === id);
    if (!row || row.status !== 'active') return null;
    Object.assign(row, fields, { status: 'triggered' as const });
    return { ...row };
  }

  async updatePriceTarget(
    id: number,
    patch: Partial<Pick<PriceTargetRow, 'status' | 'eventId' | 'triggeredAt' | 'triggeredPrice' | 'triggeredQuoteAt'>>,
  ) {
    const row = this.targets.find((t) => t.id === id);
    if (!row) throw new Error(`price target ${id} not found`);
    Object.assign(row, patch);
    return { ...row };
  }

  async recordProviderCall(input: { provider: string; endpoint: ProviderCallEndpoint; purpose: ProviderCallPurpose; calledAt: Date }) {
    const id = ++this.seq.call;
    this.providerCalls.push({ ...input, id, success: null, error: null });
    return id;
  }

  async finishProviderCall(id: number, result: { success: boolean; error: string | null }) {
    const row = this.providerCalls.find((c) => c.id === id);
    if (row) Object.assign(row, result);
  }

  async countProviderCalls(provider: string, since: Date) {
    return this.providerCalls.filter((c) => c.provider === provider && c.calledAt >= since).length;
  }
}
