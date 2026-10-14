import { ProviderError, type GoldQuote } from '../gold/types';
import { isStale, validateQuote } from '../gold/validate';
import type { InstrumentKey, ProviderCallPurpose, SettingsRow, SnapshotRow } from '../store/types';
import { safeErrorMessage, type JobDeps } from './deps';
import { getProviderBudget, meteredCall } from './provider-usage';

// 取得最新報價 → 驗證 → 寫入快照（去重）。失敗時回傳原因，絕不產生預設價格。
// 有每月次數上限的來源：先看能不能沿用剛查過的報價，再檢查查價次數，且不自動重試（避免浪費次數）。

const PROVIDER_TIMEOUT_MS = 12_000;
/** 有次數上限時，這段時間內查過的有效報價直接沿用 */
const REUSE_WINDOW_MS = 10 * 60_000;

export type FetchOutcome =
  | {
      kind: 'ok';
      quote: GoldQuote;
      snapshot: SnapshotRow;
      created: boolean;
      /** 沿用剛查過的報價，沒有呼叫行情 API */
      reused: boolean;
      stale: boolean;
      instrument: InstrumentKey;
      staleAfterMinutes: number;
    }
  | { kind: 'error'; code: string; message: string };

export type FetchPurpose = Extract<ProviderCallPurpose, 'daily' | 'check' | 'manual'>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError('行情來源逾時', 'timeout', true)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function instrumentOf(q: Pick<GoldQuote, 'source' | 'symbol' | 'currency' | 'unit'>): InstrumentKey {
  return { source: q.source, symbol: q.symbol, currency: q.currency, unit: q.unit };
}

function quoteFromSnapshot(s: SnapshotRow): GoldQuote {
  return {
    symbol: s.symbol,
    price: s.price,
    currency: s.currency,
    unit: s.unit,
    source: s.source,
    timestamp: s.quoteTimestamp,
    fetchedAt: s.fetchedAt,
    isDelayed: s.isDelayed,
    status: s.status,
  };
}

export async function fetchAndRecord(
  deps: JobDeps,
  settings: Pick<SettingsRow, 'dailyEnabled' | 'skipWeekends'>,
  purpose: FetchPurpose,
): Promise<FetchOutcome> {
  const status = deps.provider.getProviderStatus();
  if (!status.configured || !status.instrument) {
    return { kind: 'error', code: 'not_configured', message: status.notes[0] ?? '尚未設定正式行情來源' };
  }
  const now = deps.now();
  const limited = status.monthlyCallQuota !== null;
  const instrument: InstrumentKey = { source: deps.provider.id, ...status.instrument };

  if (limited) {
    const recent = await deps.store.getLatestSnapshot(instrument);
    if (
      recent &&
      recent.currency === instrument.currency &&
      recent.unit === instrument.unit &&
      now.getTime() - recent.fetchedAt.getTime() < REUSE_WINDOW_MS &&
      !isStale(recent.quoteTimestamp, now, status.staleAfterMinutes)
    ) {
      return {
        kind: 'ok',
        quote: quoteFromSnapshot(recent),
        snapshot: recent,
        created: false,
        reused: true,
        stale: false,
        instrument,
        staleAfterMinutes: status.staleAfterMinutes,
      };
    }
    const budget = await getProviderBudget(deps, settings);
    const allowed = purpose === 'daily' ? budget.canDaily : budget.canExtra;
    if (!allowed) return { kind: 'error', code: 'budget', message: budget.reason ?? '行情 API 查價次數不足' };
  }

  const retries = limited ? 0 : 1;
  let quote: GoldQuote | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      quote = await withTimeout(
        meteredCall(deps, 'latest', purpose, () => deps.provider.getLatestPrice()),
        PROVIDER_TIMEOUT_MS,
      );
      break;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError ? err.retryable : true;
      if (!retryable || attempt === retries) break;
      await deps.sleep(1000);
    }
  }
  if (!quote) {
    const code = lastError instanceof ProviderError ? lastError.code : 'unavailable';
    return { kind: 'error', code, message: safeErrorMessage(lastError) };
  }

  const validation = validateQuote(quote, status.instrument);
  if (!validation.ok) return { kind: 'error', code: 'invalid_response', message: validation.reason };
  const valid = validation.quote;

  const { snapshot, created } = await deps.store.insertSnapshot({
    symbol: valid.symbol,
    price: valid.price,
    currency: valid.currency,
    unit: valid.unit,
    source: valid.source,
    quoteTimestamp: valid.timestamp,
    fetchedAt: valid.fetchedAt,
    isDelayed: valid.isDelayed,
    status: valid.status,
  });

  return {
    kind: 'ok',
    quote: valid,
    snapshot,
    created,
    reused: false,
    stale: isStale(valid.timestamp, now, status.staleAfterMinutes),
    instrument: instrumentOf(valid),
    staleAfterMinutes: status.staleAfterMinutes,
  };
}
