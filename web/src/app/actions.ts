'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authMode, checkPassword, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';
import { MOCK_SCENARIOS } from '@/lib/gold/mock-provider';
import { isStale } from '@/lib/gold/validate';
import { runDailyJob } from '@/lib/jobs/daily';
import { describeEvent } from '@/lib/jobs/daily';
import { safeErrorMessage } from '@/lib/jobs/deps';
import { runIntradayJob } from '@/lib/jobs/intraday';
import { backfillHistory, runQuotaSyncJob } from '@/lib/jobs/maintenance';
import { retryEvent, sendTestPush } from '@/lib/jobs/notify';
import { buildDeps, isAdmin } from '@/lib/server';
import type { SettingsPatch, SettingsRow } from '@/lib/store/types';
import { hasIntradayChecks, parseCheckTimes } from '@/lib/schedule';
import { taipeiDate } from '@/lib/time';

// 每個 Server Action 都是公開的 POST 入口：一定先檢查權限、再驗證輸入。

export type ActionState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

const DENIED: ActionState = { ok: false, message: '沒有權限，請重新登入。' };

function done(message: string): ActionState {
  revalidatePath('/', 'layout');
  return { ok: true, message };
}

// ---------- 登入 ----------

function safeNext(value: FormDataEntryValue | null): string {
  const v = typeof value === 'string' ? value : '';
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const env = getEnv();
  if (authMode(env) !== 'login') return { ok: false, message: '伺服器尚未設定 ADMIN_PASSWORD 與 SESSION_SECRET。' };
  const password = String(formData.get('password') ?? '');
  if (!checkPassword(password, env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 800)); // 拖慢暴力嘗試
    return { ok: false, message: '密碼不正確。' };
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(env.SESSION_SECRET!, new Date()), {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(safeNext(formData.get('next')));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

// ---------- 設定 ----------

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const settingsSchema = z
  .object({
    dailyEnabled: bool,
    dailyPushTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '請輸入 HH:MM 格式的時間'),
    alertEnabled: bool,
    riseThresholdPercent: z.coerce.number({ error: '請輸入數字' }).min(0.1, '請輸入 0.1 到 20 之間的百分比').max(20, '請輸入 0.1 到 20 之間的百分比'),
    fallThresholdPercent: z.coerce.number({ error: '請輸入數字' }).min(0.1, '請輸入 0.1 到 20 之間的百分比').max(20, '請輸入 0.1 到 20 之間的百分比'),
    intradayMode: z.enum(['times', 'interval', 'off'], { error: '請選擇盤中檢查方式' }),
    checkTimes: z.string(),
    pollingIntervalMinutes: z.enum(['15', '30', '60'], { error: '請選擇檢查間隔' }).transform((v) => Number(v) as 15 | 30 | 60),
    skipWeekends: bool,
    cooldownMinutes: z.coerce.number({ error: '請輸入數字' }).int('請輸入整數').min(15, '請輸入 15 到 1440 之間的整數（分鐘）').max(1440, '請輸入 15 到 1440 之間的整數（分鐘）'),
    baselineMode: z.enum(['first_valid_of_day', 'previous_close', 'manual'], { error: '請選擇參考基準' }),
    manualBaselinePrice: z.string().optional(),
    linePlan: z.enum(['light_free', 'medium', 'high', 'other'], { error: '請選擇 LINE 方案' }),
    monthlyMessageQuota: z.coerce.number({ error: '請輸入數字' }).int('請輸入整數').min(1, '請輸入正整數').max(1_000_000, '數字太大'),
    quotaSafetyBuffer: z.coerce.number({ error: '請輸入數字' }).int('請輸入整數').min(0, '請輸入 0 到 100 之間的整數').max(100, '請輸入 0 到 100 之間的整數'),
  })
  .superRefine((v, ctx) => {
    if (v.intradayMode === 'times') {
      const times = parseCheckTimes(v.checkTimes);
      if (!times || times.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['checkTimes'], message: '請輸入 HH:MM 格式的時間，多個時間用逗號分開，例如 21:30' });
      } else if (times.length > 6) {
        ctx.addIssue({ code: 'custom', path: ['checkTimes'], message: '最多 6 個檢查時間' });
      }
    }
    if (v.baselineMode !== 'manual') return;
    const price = Number(v.manualBaselinePrice);
    if (!v.manualBaselinePrice || !Number.isFinite(price) || price <= 0) {
      ctx.addIssue({ code: 'custom', path: ['manualBaselinePrice'], message: '請輸入大於 0 的基準價格' });
    }
  });

function currentAsForm(s: SettingsRow): Record<string, string> {
  return {
    dailyEnabled: String(s.dailyEnabled),
    dailyPushTime: s.dailyPushTime,
    alertEnabled: String(s.alertEnabled),
    riseThresholdPercent: String(s.riseThresholdPercent),
    fallThresholdPercent: String(s.fallThresholdPercent),
    intradayMode: s.intradayMode,
    checkTimes: s.checkTimes.join(', '),
    pollingIntervalMinutes: String(s.pollingIntervalMinutes || 15),
    skipWeekends: String(s.skipWeekends),
    cooldownMinutes: String(s.cooldownMinutes),
    baselineMode: s.baselineMode,
    manualBaselinePrice: s.baselineMode === 'manual' && s.baselinePrice ? String(s.baselinePrice) : '',
    linePlan: s.linePlan,
    monthlyMessageQuota: String(s.monthlyMessageQuota),
    quotaSafetyBuffer: String(s.quotaSafetyBuffer),
  };
}

export async function saveSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const deps = await buildDeps();
  const current = await deps.store.getSettings();
  // 停用的區塊不會送出欄位，沿用目前的值
  const raw: Record<string, string> = currentAsForm(current);
  for (const [k, v] of formData.entries()) if (typeof v === 'string' && k in raw) raw[k] = v;

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, message: `有 ${Object.keys(fieldErrors).length} 個欄位需要修正。`, fieldErrors };
  }
  const v = parsed.data;
  const patch: SettingsPatch = {
    dailyEnabled: v.dailyEnabled,
    dailyPushTime: v.dailyPushTime,
    alertEnabled: v.alertEnabled,
    riseThresholdPercent: v.riseThresholdPercent,
    fallThresholdPercent: v.fallThresholdPercent,
    intradayMode: v.intradayMode,
    checkTimes: v.intradayMode === 'times' ? parseCheckTimes(v.checkTimes) ?? current.checkTimes : current.checkTimes,
    pollingIntervalMinutes: v.pollingIntervalMinutes,
    skipWeekends: v.skipWeekends,
    cooldownMinutes: v.cooldownMinutes,
    baselineMode: v.baselineMode,
    linePlan: v.linePlan,
    monthlyMessageQuota: v.monthlyMessageQuota,
    quotaSafetyBuffer: v.quotaSafetyBuffer,
  };
  if (v.baselineMode === 'manual') {
    const price = Number(v.manualBaselinePrice);
    if (current.baselineMode !== 'manual' || current.baselinePrice !== price) {
      Object.assign(patch, { baselinePrice: price, baselineTimestamp: deps.now(), baselineDate: null });
    }
  } else if (
    current.baselineMode !== v.baselineMode ||
    hasIntradayChecks(current) !== hasIntradayChecks({ intradayMode: v.intradayMode, checkTimes: patch.checkTimes!, pollingIntervalMinutes: v.pollingIntervalMinutes })
  ) {
    // 換了基準規則：清掉目前基準，下一筆有效報價依新規則重新建立
    Object.assign(patch, { baselinePrice: null, baselineTimestamp: null, baselineDate: null });
  }
  try {
    await deps.store.updateSettings(patch);
  } catch (err) {
    return { ok: false, message: safeErrorMessage(err) };
  }
  return done('設定已儲存。');
}

export async function resetBaselineAction(_prev: ActionState): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const deps = await buildDeps();
  const settings = await deps.store.getSettings();
  if (settings.baselineMode === 'manual') return { ok: false, message: '手動模式請直接修改基準價格。' };
  const status = deps.provider.getProviderStatus();
  if (!status.instrument) return { ok: false, message: '尚未設定行情來源。' };
  const latest = await deps.store.getLatestSnapshot({ source: deps.provider.id, symbol: status.instrument.symbol });
  const now = deps.now();
  if (!latest || isStale(latest.quoteTimestamp, now, status.staleAfterMinutes)) {
    await deps.store.updateSettings({ baselinePrice: null, baselineTimestamp: null, baselineDate: null });
    return done('目前沒有有效的最新報價；下一筆有效報價會成為新基準。');
  }
  await deps.store.updateSettings({ baselinePrice: latest.price, baselineTimestamp: latest.quoteTimestamp, baselineDate: taipeiDate(now) });
  return done(`今天的基準已改為最新有效報價 ${latest.price.toFixed(2)}。`);
}

export async function setMockScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const value = String(formData.get('mockScenario') ?? '');
  const scenario = MOCK_SCENARIOS.find((s) => s.value === value);
  if (!scenario) return { ok: false, message: '不支援的測試情境。' };
  const deps = await buildDeps();
  await deps.store.updateSettings({ mockScenario: scenario.value });
  return done(`Mock 情境已改為「${scenario.label}」。`);
}

// ---------- 推播與排程 ----------

export async function testPushAction(_prev: ActionState): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const deps = await buildDeps();
  const { event, withChart } = await sendTestPush(deps);
  const ok = event.status === 'sent';
  revalidatePath('/', 'layout');
  return {
    ok,
    message: ok
      ? `測試推播已送出${withChart ? '（含每日行情預覽與走勢圖）' : ''}，請查看 LINE。`
      : `測試推播${describeEvent(event)}${event.lastError ? `：${event.lastError}` : ''}`,
  };
}

export async function retryEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const id = Number(formData.get('eventId'));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '事件編號不正確。' };
  const result = await retryEvent(await buildDeps(), id);
  revalidatePath('/', 'layout');
  if (!result.ok) return { ok: false, message: result.reason };
  return { ok: result.event.status === 'sent', message: `重試結果：${describeEvent(result.event)}` };
}

export async function runJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const job = String(formData.get('job') ?? '');
  const deps = await buildDeps();
  const outcome =
    job === 'daily'
      ? await runDailyJob(deps, { trigger: 'manual' })
      : job === 'intraday'
        ? await runIntradayJob(deps, { trigger: 'manual' })
        : job === 'quota_sync'
          ? await runQuotaSyncJob(deps, { trigger: 'manual' })
          : null;
  if (!outcome) return { ok: false, message: '不支援的工作。' };
  revalidatePath('/', 'layout');
  return { ok: outcome.status !== 'failed', message: outcome.detail };
}

export async function backfillAction(_prev: ActionState): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const result = await backfillHistory(await buildDeps(), 90);
  revalidatePath('/', 'layout');
  return { ok: result.inserted >= 0, message: result.message };
}

// ---------- 到價提醒 ----------

const MAX_ACTIVE_TARGETS = 10;

const targetSchema = z.object({
  direction: z.enum(['above', 'below'], { error: '請選擇方向' }),
  targetPrice: z.coerce.number({ error: '請輸入數字' }).positive('請輸入大於 0 的價格').max(1_000_000, '價格太大'),
  note: z.string().trim().max(40, '備註最多 40 個字').optional(),
});

export async function addTargetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const parsed = targetSchema.safeParse({
    direction: formData.get('direction'),
    targetPrice: formData.get('targetPrice'),
    note: formData.get('note') ?? undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
    return { ok: false, message: '請修正到價提醒的欄位。', fieldErrors };
  }
  const deps = await buildDeps();
  const status = deps.provider.getProviderStatus();
  if (!status.configured || !status.instrument) return { ok: false, message: '尚未設定行情來源，無法建立到價提醒。' };
  const active = await deps.store.listPriceTargets({ statuses: ['active'], limit: MAX_ACTIVE_TARGETS + 1 });
  if (active.length >= MAX_ACTIVE_TARGETS) return { ok: false, message: `最多同時 ${MAX_ACTIVE_TARGETS} 個到價提醒。` };
  const v = parsed.data;
  await deps.store.insertPriceTarget({
    source: deps.provider.id,
    ...status.instrument,
    direction: v.direction,
    targetPrice: Math.round(v.targetPrice * 100) / 100,
    note: v.note ? v.note : null,
  });
  return done(`已新增到價提醒：${v.direction === 'above' ? '漲到' : '跌到'} ${v.targetPrice.toFixed(2)} ${v.direction === 'above' ? '以上' : '以下'}。`);
}

export async function cancelTargetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const id = Number(formData.get('targetId'));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '編號不正確。' };
  const deps = await buildDeps();
  const target = (await deps.store.listPriceTargets({ limit: 200 })).find((t) => t.id === id);
  if (!target || target.status !== 'active') return { ok: false, message: '這個到價提醒已經不是啟用狀態。' };
  await deps.store.updatePriceTarget(id, { status: 'cancelled' });
  return done('已取消到價提醒。');
}

export async function rearmTargetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await isAdmin())) return DENIED;
  const id = Number(formData.get('targetId'));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '編號不正確。' };
  const deps = await buildDeps();
  const target = (await deps.store.listPriceTargets({ limit: 200 })).find((t) => t.id === id);
  if (!target || target.status === 'active') return { ok: false, message: '這個到價提醒已經是啟用狀態。' };
  const active = await deps.store.listPriceTargets({ statuses: ['active'], limit: MAX_ACTIVE_TARGETS + 1 });
  if (active.length >= MAX_ACTIVE_TARGETS) return { ok: false, message: `最多同時 ${MAX_ACTIVE_TARGETS} 個到價提醒。` };
  // 重新啟用＝建立一筆新的目標價，保留舊的觸發紀錄
  await deps.store.insertPriceTarget({
    source: target.source,
    symbol: target.symbol,
    currency: target.currency,
    unit: target.unit,
    direction: target.direction,
    targetPrice: target.targetPrice,
    note: target.note,
  });
  return done('已重新啟用到價提醒。');
}
