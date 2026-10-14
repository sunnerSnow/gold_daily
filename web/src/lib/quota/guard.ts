import { remainingDaysInLineBillingMonth } from '../time';
import type { QuotaSyncRow } from '../store/types';

// LINE 訊息額度保護。原則：
// 1. 以 LINE 官方用量為準；本地紀錄只做保守估算，兩者取剩餘較少的那個。
// 2. 查不到官方用量（或太久沒同步）就視為額度不足，不假設還有免費額度。
// 3. 每日推播優先：異動提醒與測試推播要留下「本月剩餘天數 × 每日 1 則 + 安全緩衝」。
// 4. 月份依 LINE 的計費規則用日本時間切換（見 time.ts 的 LINE_BILLING_TIMEZONE）。

/** 官方用量超過這個時間沒同步成功，就視為無法確認 */
export const QUOTA_SYNC_MAX_AGE_MS = 6 * 3600_000;

export type MessageKind = 'daily' | 'alert' | 'test';

export interface QuotaInput {
  now: Date;
  latestSuccessfulSync: QuotaSyncRow | null;
  /** 本地紀錄本計費月（日本時間）已送出的則數 */
  localSentThisMonth: number;
  /** 設定頁填的當期方案每月額度 */
  monthlyMessageQuota: number;
  quotaSafetyBuffer: number;
  dailyEnabled: boolean;
}

export interface QuotaState {
  verified: boolean;
  officialLimit: number | null;
  officialUsed: number | null;
  /** 本地估算剩餘（設定額度 − 本地已送出） */
  localRemaining: number;
  /** 保守估算剩餘（官方與本地取較小值）；無法確認時為 null */
  remaining: number | null;
  reserveForDaily: number;
  canSend: Record<MessageKind, boolean>;
  /** 為什麼暫停（給畫面顯示）；沒有暫停時為 null */
  pausedReason: string | null;
  lastSyncAt: Date | null;
}

export function computeQuotaState(input: QuotaInput): QuotaState {
  const sync = input.latestSuccessfulSync;
  const fresh = Boolean(sync && input.now.getTime() - sync.syncedAt.getTime() <= QUOTA_SYNC_MAX_AGE_MS);
  const localRemaining = Math.max(0, input.monthlyMessageQuota - input.localSentThisMonth);
  const reserveForDaily = (input.dailyEnabled ? remainingDaysInLineBillingMonth(input.now) : 0) + input.quotaSafetyBuffer;

  if (!fresh || !sync) {
    return {
      verified: false,
      officialLimit: sync?.quotaType === 'limited' ? sync.quotaValue : null,
      officialUsed: sync?.totalUsage ?? null,
      localRemaining,
      remaining: null,
      reserveForDaily,
      canSend: { daily: false, alert: false, test: false },
      pausedReason: sync
        ? '超過 6 小時沒有成功同步 LINE 官方用量，無法確認剩餘額度，已暫停推播。'
        : '尚未取得 LINE 官方用量，無法確認剩餘額度，已暫停推播。',
      lastSyncAt: sync?.syncedAt ?? null,
    };
  }

  const officialUsed = sync.totalUsage ?? 0;
  // 官方回 none（無上限，通常是付費方案）時，以設定頁的方案額度為上限，避免產生額外費用
  const officialLimit = sync.quotaType === 'limited' ? sync.quotaValue : null;
  const cap = officialLimit ?? input.monthlyMessageQuota;
  const officialRemaining = Math.max(0, cap - officialUsed);
  const remaining = Math.min(officialRemaining, localRemaining);

  const canDaily = remaining >= 1;
  const canExtra = remaining - reserveForDaily >= 1;
  let pausedReason: string | null = null;
  if (!canDaily) pausedReason = '本月訊息額度已用完，已暫停所有推播（不會自動升級或加購）。';
  else if (!canExtra) pausedReason = `剩餘 ${remaining} 則，需保留 ${reserveForDaily} 則給每日推播，已暫停異動提醒與測試推播。`;

  return {
    verified: true,
    officialLimit,
    officialUsed,
    localRemaining,
    remaining,
    reserveForDaily,
    canSend: { daily: canDaily, alert: canExtra, test: canExtra },
    pausedReason,
    lastSyncAt: sync.syncedAt,
  };
}
