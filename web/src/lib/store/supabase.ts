import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

// Supabase 實作：只在伺服器端用 service_role 金鑰。錯誤訊息不帶任何金鑰或連線字串。

type Row = Record<string, unknown>;

export class StoreError extends Error {
  constructor(operation: string, cause: { message?: string; code?: string } | null) {
    super(`資料庫操作失敗（${operation}）${cause?.code ? `：${cause.code}` : ''}`);
    this.name = 'StoreError';
  }
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v ? new Date(String(v)) : null);

function toSnapshot(r: Row): SnapshotRow {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    price: Number(r.price),
    currency: String(r.currency),
    unit: r.unit as SnapshotRow['unit'],
    source: String(r.source),
    quoteTimestamp: new Date(String(r.quote_timestamp)),
    fetchedAt: new Date(String(r.fetched_at)),
    isDelayed: r.is_delayed === null ? null : Boolean(r.is_delayed),
    status: r.status as SnapshotRow['status'],
    dailyDate: (r.daily_date as string | null) ?? null,
    createdAt: new Date(String(r.created_at)),
  };
}

function toSettings(r: Row): SettingsRow {
  return {
    dailyEnabled: Boolean(r.daily_enabled),
    dailyPushTime: String(r.daily_push_time).slice(0, 5),
    alertEnabled: Boolean(r.alert_enabled),
    riseThresholdPercent: Number(r.rise_threshold_percent),
    fallThresholdPercent: Number(r.fall_threshold_percent),
    intradayMode: ((r.intraday_mode as string | undefined) ?? 'times') as SettingsRow['intradayMode'],
    checkTimes: String(r.check_times ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .sort(),
    pollingIntervalMinutes: Number(r.polling_interval_minutes) as SettingsRow['pollingIntervalMinutes'],
    skipWeekends: r.skip_weekends === undefined ? true : Boolean(r.skip_weekends),
    cooldownMinutes: Number(r.cooldown_minutes),
    baselineMode: r.baseline_mode as SettingsRow['baselineMode'],
    baselinePrice: num(r.baseline_price),
    baselineTimestamp: date(r.baseline_timestamp),
    baselineDate: (r.baseline_date as string | null) ?? null,
    timezone: String(r.timezone),
    linePlan: String(r.line_plan),
    monthlyMessageQuota: Number(r.monthly_message_quota),
    quotaSafetyBuffer: Number(r.quota_safety_buffer),
    mockScenario: r.mock_scenario as SettingsRow['mockScenario'],
    createdAt: new Date(String(r.created_at)),
    updatedAt: new Date(String(r.updated_at)),
  };
}

const SETTINGS_COLUMNS: Record<keyof SettingsPatch, string> = {
  dailyEnabled: 'daily_enabled',
  dailyPushTime: 'daily_push_time',
  alertEnabled: 'alert_enabled',
  riseThresholdPercent: 'rise_threshold_percent',
  fallThresholdPercent: 'fall_threshold_percent',
  intradayMode: 'intraday_mode',
  checkTimes: 'check_times',
  pollingIntervalMinutes: 'polling_interval_minutes',
  skipWeekends: 'skip_weekends',
  cooldownMinutes: 'cooldown_minutes',
  baselineMode: 'baseline_mode',
  baselinePrice: 'baseline_price',
  baselineTimestamp: 'baseline_timestamp',
  baselineDate: 'baseline_date',
  linePlan: 'line_plan',
  monthlyMessageQuota: 'monthly_message_quota',
  quotaSafetyBuffer: 'quota_safety_buffer',
  mockScenario: 'mock_scenario',
};

function toEvent(r: Row): EventRow {
  return {
    id: Number(r.id),
    eventType: r.event_type as EventType,
    symbol: (r.symbol as string | null) ?? null,
    currentPrice: num(r.current_price),
    baselinePrice: num(r.baseline_price),
    changePercent: num(r.change_percent),
    thresholdPercent: num(r.threshold_percent),
    sourceTimestamp: date(r.source_timestamp),
    idempotencyKey: String(r.idempotency_key),
    lineRetryKey: String(r.line_retry_key),
    messageText: (r.message_text as string | null) ?? null,
    status: r.status as EventStatus,
    skipReason: (r.skip_reason as EventRow['skipReason']) ?? null,
    attemptCount: Number(r.attempt_count),
    lastError: (r.last_error as string | null) ?? null,
    sentAt: date(r.sent_at),
    createdAt: new Date(String(r.created_at)),
    updatedAt: new Date(String(r.updated_at)),
  };
}

function toJobRun(r: Row): JobRunRow {
  return {
    id: Number(r.id),
    jobType: r.job_type as JobType,
    trigger: r.trigger as JobTrigger,
    startedAt: new Date(String(r.started_at)),
    finishedAt: date(r.finished_at),
    status: r.status as JobStatus,
    recordsProcessed: Number(r.records_processed),
    errorMessage: (r.error_message as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    createdAt: new Date(String(r.created_at)),
  };
}

function toQuotaSync(r: Row): QuotaSyncRow {
  return {
    id: Number(r.id),
    syncedAt: new Date(String(r.synced_at)),
    success: Boolean(r.success),
    quotaType: (r.quota_type as QuotaSyncRow['quotaType']) ?? null,
    quotaValue: num(r.quota_value),
    totalUsage: num(r.total_usage),
    errorMessage: (r.error_message as string | null) ?? null,
  };
}

function toTarget(r: Row): PriceTargetRow {
  return {
    id: Number(r.id),
    direction: r.direction as PriceTargetRow['direction'],
    targetPrice: Number(r.target_price),
    source: String(r.source),
    symbol: String(r.symbol),
    currency: String(r.currency),
    unit: r.unit as PriceTargetRow['unit'],
    status: r.status as TargetStatus,
    note: (r.note as string | null) ?? null,
    createdAt: new Date(String(r.created_at)),
    triggeredAt: date(r.triggered_at),
    triggeredPrice: num(r.triggered_price),
    triggeredQuoteAt: date(r.triggered_quote_at),
    eventId: num(r.event_id),
  };
}

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    });
  }

  private instrumentQuery(table: string, k: InstrumentKey) {
    return this.db.from(table).select('*').eq('source', k.source).eq('symbol', k.symbol).eq('currency', k.currency).eq('unit', k.unit);
  }

  async insertSnapshot(input: NewSnapshot) {
    const row = {
      symbol: input.symbol,
      price: input.price,
      currency: input.currency,
      unit: input.unit,
      source: input.source,
      quote_timestamp: input.quoteTimestamp.toISOString(),
      fetched_at: input.fetchedAt.toISOString(),
      is_delayed: input.isDelayed,
      status: input.status,
    };
    const inserted = await this.db
      .from('gold_price_snapshots')
      .upsert(row, { onConflict: 'source,symbol,quote_timestamp', ignoreDuplicates: true })
      .select();
    if (inserted.error) throw new StoreError('寫入快照', inserted.error);
    if (inserted.data && inserted.data.length > 0) return { snapshot: toSnapshot(inserted.data[0]), created: true };
    const existing = await this.db
      .from('gold_price_snapshots')
      .select('*')
      .eq('source', input.source)
      .eq('symbol', input.symbol)
      .eq('quote_timestamp', row.quote_timestamp)
      .single();
    if (existing.error) throw new StoreError('讀取既有快照', existing.error);
    return { snapshot: toSnapshot(existing.data), created: false };
  }

  async markDailySnapshot(id: number, dailyDate: string) {
    const current = await this.db.from('gold_price_snapshots').select('daily_date').eq('id', id).maybeSingle();
    if (current.error) throw new StoreError('讀取快照', current.error);
    if (!current.data) return false;
    if (current.data.daily_date === dailyDate) return true;
    if (current.data.daily_date) return false;
    const updated = await this.db
      .from('gold_price_snapshots')
      .update({ daily_date: dailyDate })
      .eq('id', id)
      .is('daily_date', null)
      .select('id');
    if (updated.error) {
      if (updated.error.code === '23505') return false; // 那天已有每日快照
      throw new StoreError('標記每日快照', updated.error);
    }
    return (updated.data?.length ?? 0) > 0;
  }

  async getDailySnapshot(instrument: InstrumentKey, dailyDate: string) {
    const r = await this.instrumentQuery('gold_price_snapshots', instrument).eq('daily_date', dailyDate).maybeSingle();
    if (r.error) throw new StoreError('讀取每日快照', r.error);
    return r.data ? toSnapshot(r.data) : null;
  }

  async getPreviousDailySnapshot(instrument: InstrumentKey, beforeDate: string) {
    const r = await this.instrumentQuery('gold_price_snapshots', instrument)
      .lt('daily_date', beforeDate)
      .order('daily_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new StoreError('讀取前一交易日快照', r.error);
    return r.data ? toSnapshot(r.data) : null;
  }

  async getFirstSnapshotSince(instrument: InstrumentKey, since: Date) {
    const r = await this.instrumentQuery('gold_price_snapshots', instrument)
      .gte('quote_timestamp', since.toISOString())
      .order('quote_timestamp', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new StoreError('讀取當日首筆報價', r.error);
    return r.data ? toSnapshot(r.data) : null;
  }

  async getLatestSnapshot(instrument: Pick<InstrumentKey, 'source' | 'symbol'>) {
    const r = await this.db
      .from('gold_price_snapshots')
      .select('*')
      .eq('source', instrument.source)
      .eq('symbol', instrument.symbol)
      .order('quote_timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new StoreError('讀取最新快照', r.error);
    return r.data ? toSnapshot(r.data) : null;
  }

  async listDailySnapshots(query: DailySnapshotQuery) {
    let q = this.db.from('gold_price_snapshots').select('*', { count: 'exact' }).not('daily_date', 'is', null);
    if (query.instrument) q = q.eq('source', query.instrument.source).eq('symbol', query.instrument.symbol);
    if (query.from) q = q.gte('daily_date', query.from);
    if (query.to) q = q.lte('daily_date', query.to);
    q = q.order('daily_date', { ascending: false });
    if (query.limit !== undefined) {
      const offset = query.offset ?? 0;
      q = q.range(offset, offset + query.limit - 1);
    }
    const r = await q;
    if (r.error) throw new StoreError('讀取歷史快照', r.error);
    return { rows: (r.data ?? []).map(toSnapshot), total: r.count ?? 0 };
  }

  async getSettings() {
    const r = await this.db.from('notification_settings').select('*').eq('id', 1).maybeSingle();
    if (r.error) throw new StoreError('讀取設定', r.error);
    if (r.data) return toSettings(r.data);
    const created = await this.db.from('notification_settings').upsert({ id: 1 }, { onConflict: 'id' }).select().single();
    if (created.error) throw new StoreError('建立預設設定', created.error);
    return created.data ? toSettings(created.data) : { ...DEFAULT_SETTINGS, createdAt: new Date(), updatedAt: new Date() };
  }

  async updateSettings(patch: SettingsPatch) {
    const row: Row = { updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(patch) as [keyof SettingsPatch, unknown][]) {
      if (value === undefined) continue;
      row[SETTINGS_COLUMNS[key]] = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(',') : value;
    }
    const r = await this.db.from('notification_settings').update(row).eq('id', 1).select().single();
    if (r.error) throw new StoreError('更新設定', r.error);
    return toSettings(r.data);
  }

  async insertEvent(input: NewEvent) {
    const row = {
      event_type: input.eventType,
      symbol: input.symbol ?? null,
      current_price: input.currentPrice ?? null,
      baseline_price: input.baselinePrice ?? null,
      change_percent: input.changePercent ?? null,
      threshold_percent: input.thresholdPercent ?? null,
      source_timestamp: input.sourceTimestamp?.toISOString() ?? null,
      idempotency_key: input.idempotencyKey,
      message_text: input.messageText ?? null,
      status: input.status ?? 'pending',
      skip_reason: input.skipReason ?? null,
    };
    const inserted = await this.db
      .from('notification_events')
      .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select();
    if (inserted.error) throw new StoreError('寫入通知事件', inserted.error);
    if (inserted.data && inserted.data.length > 0) return { event: toEvent(inserted.data[0]), created: true };
    const existing = await this.db.from('notification_events').select('*').eq('idempotency_key', input.idempotencyKey).single();
    if (existing.error) throw new StoreError('讀取既有通知事件', existing.error);
    return { event: toEvent(existing.data), created: false };
  }

  async updateEvent(id: number, patch: EventPatch) {
    const row: Row = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.skipReason !== undefined) row.skip_reason = patch.skipReason;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.lastError !== undefined) row.last_error = patch.lastError;
    if (patch.sentAt !== undefined) row.sent_at = patch.sentAt?.toISOString() ?? null;
    if (patch.messageText !== undefined) row.message_text = patch.messageText;
    const r = await this.db.from('notification_events').update(row).eq('id', id).select().single();
    if (r.error) throw new StoreError('更新通知事件', r.error);
    return toEvent(r.data);
  }

  async getEvent(id: number) {
    const r = await this.db.from('notification_events').select('*').eq('id', id).maybeSingle();
    if (r.error) throw new StoreError('讀取通知事件', r.error);
    return r.data ? toEvent(r.data) : null;
  }

  async getEventByKey(idempotencyKey: string) {
    const r = await this.db.from('notification_events').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
    if (r.error) throw new StoreError('讀取通知事件', r.error);
    return r.data ? toEvent(r.data) : null;
  }

  async getLastEvent(types: EventType[], statuses: EventStatus[], since?: Date) {
    let q = this.db.from('notification_events').select('*').in('event_type', types).in('status', statuses);
    if (since) q = q.gte('created_at', since.toISOString());
    const r = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
    if (r.error) throw new StoreError('讀取最近通知事件', r.error);
    return r.data ? toEvent(r.data) : null;
  }

  async listEvents(options: { types?: EventType[]; limit: number }) {
    let q = this.db.from('notification_events').select('*');
    if (options.types) q = q.in('event_type', options.types);
    const r = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(options.limit);
    if (r.error) throw new StoreError('讀取通知事件', r.error);
    return (r.data ?? []).map(toEvent);
  }

  async countSentSince(since: Date) {
    const r = await this.db
      .from('notification_events')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', since.toISOString());
    if (r.error) throw new StoreError('統計已送出訊息', r.error);
    return r.count ?? 0;
  }

  async startJobRun(jobType: JobType, trigger: JobTrigger) {
    const r = await this.db.from('job_runs').insert({ job_type: jobType, trigger, status: 'running' }).select().single();
    if (r.error) throw new StoreError('寫入排程紀錄', r.error);
    return toJobRun(r.data);
  }

  async finishJobRun(id: number, patch: JobRunPatch) {
    const row: Row = { finished_at: (patch.finishedAt ?? new Date()).toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.recordsProcessed !== undefined) row.records_processed = patch.recordsProcessed;
    if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage;
    if (patch.detail !== undefined) row.detail = patch.detail;
    const r = await this.db.from('job_runs').update(row).eq('id', id).select().single();
    if (r.error) throw new StoreError('更新排程紀錄', r.error);
    return toJobRun(r.data);
  }

  async listJobRuns(options: { jobType?: JobType; status?: JobStatus; limit: number }) {
    let q = this.db.from('job_runs').select('*');
    if (options.jobType) q = q.eq('job_type', options.jobType);
    if (options.status) q = q.eq('status', options.status);
    const r = await q.order('started_at', { ascending: false }).order('id', { ascending: false }).limit(options.limit);
    if (r.error) throw new StoreError('讀取排程紀錄', r.error);
    return (r.data ?? []).map(toJobRun);
  }

  async getLastJobRun(jobType: JobType, statuses?: JobStatus[]) {
    let q = this.db.from('job_runs').select('*').eq('job_type', jobType);
    if (statuses) q = q.in('status', statuses);
    const r = await q.order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
    if (r.error) throw new StoreError('讀取排程紀錄', r.error);
    return r.data ? toJobRun(r.data) : null;
  }

  async tryAcquireLock(jobType: string, owner: string, ttlSeconds: number) {
    const r = await this.db.rpc('try_acquire_job_lock', { p_job: jobType, p_owner: owner, p_ttl_seconds: ttlSeconds });
    if (r.error) throw new StoreError('取得排程鎖', r.error);
    return r.data === true;
  }

  async releaseLock(jobType: string, owner: string) {
    const r = await this.db.rpc('release_job_lock', { p_job: jobType, p_owner: owner });
    if (r.error) throw new StoreError('釋放排程鎖', r.error);
  }

  async recordCronCall(jobType: string, at: Date) {
    // 只更新呼叫時間，不碰鎖；還沒有這一列時新增一列「沒有上鎖」的（locked_until 設在過去）
    const iso = at.toISOString();
    const r = await this.db.from('job_locks').update({ last_called_at: iso }).eq('job_type', jobType).select('job_type');
    if (r.error) throw new StoreError('記錄排程呼叫', r.error);
    if ((r.data ?? []).length > 0) return;
    const ins = await this.db
      .from('job_locks')
      .insert({ job_type: jobType, locked_until: new Date(0).toISOString(), owner: '00000000-0000-0000-0000-000000000000', last_called_at: iso });
    // 23505：同時有另一個請求先新增了，等於已經記錄
    if (ins.error && ins.error.code !== '23505') throw new StoreError('記錄排程呼叫', ins.error);
  }

  async getLocks(): Promise<JobLockRow[]> {
    const r = await this.db.from('job_locks').select('*');
    if (r.error) throw new StoreError('讀取排程鎖', r.error);
    return (r.data ?? []).map((l: Row) => ({
      jobType: String(l.job_type),
      lockedUntil: new Date(String(l.locked_until)),
      owner: String(l.owner),
      lastCalledAt: date(l.last_called_at),
    }));
  }

  async insertQuotaSync(input: NewQuotaSync) {
    const r = await this.db
      .from('line_quota_syncs')
      .insert({
        synced_at: input.syncedAt.toISOString(),
        success: input.success,
        quota_type: input.quotaType,
        quota_value: input.quotaValue,
        total_usage: input.totalUsage,
        error_message: input.errorMessage,
      })
      .select()
      .single();
    if (r.error) throw new StoreError('寫入額度同步紀錄', r.error);
    return toQuotaSync(r.data);
  }

  async getLatestQuotaSync(options?: { successOnly?: boolean }) {
    let q = this.db.from('line_quota_syncs').select('*');
    if (options?.successOnly) q = q.eq('success', true);
    const r = await q.order('synced_at', { ascending: false }).limit(1).maybeSingle();
    if (r.error) throw new StoreError('讀取額度同步紀錄', r.error);
    return r.data ? toQuotaSync(r.data) : null;
  }

  async insertPriceTarget(input: NewPriceTarget) {
    const r = await this.db
      .from('price_targets')
      .insert({
        direction: input.direction,
        target_price: input.targetPrice,
        source: input.source,
        symbol: input.symbol,
        currency: input.currency,
        unit: input.unit,
        note: input.note,
      })
      .select()
      .single();
    if (r.error) throw new StoreError('新增到價提醒', r.error);
    return toTarget(r.data);
  }

  async listPriceTargets(options: { statuses?: TargetStatus[]; limit: number }) {
    let q = this.db.from('price_targets').select('*');
    if (options.statuses) q = q.in('status', options.statuses);
    const r = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(options.limit);
    if (r.error) throw new StoreError('讀取到價提醒', r.error);
    return (r.data ?? []).map(toTarget);
  }

  async triggerPriceTarget(id: number, fields: { triggeredAt: Date; triggeredPrice: number; triggeredQuoteAt: Date }) {
    const r = await this.db
      .from('price_targets')
      .update({
        status: 'triggered',
        triggered_at: fields.triggeredAt.toISOString(),
        triggered_price: fields.triggeredPrice,
        triggered_quote_at: fields.triggeredQuoteAt.toISOString(),
      })
      .eq('id', id)
      .eq('status', 'active')
      .select();
    if (r.error) throw new StoreError('觸發到價提醒', r.error);
    return r.data && r.data.length > 0 ? toTarget(r.data[0]) : null;
  }

  async updatePriceTarget(
    id: number,
    patch: Partial<Pick<PriceTargetRow, 'status' | 'eventId' | 'triggeredAt' | 'triggeredPrice' | 'triggeredQuoteAt'>>,
  ) {
    const row: Row = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.eventId !== undefined) row.event_id = patch.eventId;
    if (patch.triggeredAt !== undefined) row.triggered_at = patch.triggeredAt?.toISOString() ?? null;
    if (patch.triggeredPrice !== undefined) row.triggered_price = patch.triggeredPrice;
    if (patch.triggeredQuoteAt !== undefined) row.triggered_quote_at = patch.triggeredQuoteAt?.toISOString() ?? null;
    const r = await this.db.from('price_targets').update(row).eq('id', id).select().single();
    if (r.error) throw new StoreError('更新到價提醒', r.error);
    return toTarget(r.data);
  }

  async recordProviderCall(input: { provider: string; endpoint: ProviderCallEndpoint; purpose: ProviderCallPurpose; calledAt: Date }) {
    const r = await this.db
      .from('provider_calls')
      .insert({ provider: input.provider, endpoint: input.endpoint, purpose: input.purpose, called_at: input.calledAt.toISOString() })
      .select('id')
      .single();
    if (r.error) throw new StoreError('記錄查價次數', r.error);
    return Number(r.data.id);
  }

  async finishProviderCall(id: number, result: { success: boolean; error: string | null }) {
    const r = await this.db.from('provider_calls').update({ success: result.success, error: result.error }).eq('id', id);
    if (r.error) throw new StoreError('更新查價紀錄', r.error);
  }

  async countProviderCalls(provider: string, since: Date) {
    const r = await this.db
      .from('provider_calls')
      .select('id', { count: 'exact', head: true })
      .eq('provider', provider)
      .gte('called_at', since.toISOString());
    if (r.error) throw new StoreError('統計查價次數', r.error);
    return r.count ?? 0;
  }
}
