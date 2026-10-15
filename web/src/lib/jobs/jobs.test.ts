import { describe, expect, it } from 'vitest';
import { evaluateAlert, isInCooldown, resolveBaseline } from '../alerts/evaluate';
import { UnconfiguredLineClient } from '../line/client';
import { computeQuotaState } from '../quota/guard';
import type { QuotaSyncRow } from '../store/types';
import { runDailyJob } from './daily';
import { runIntradayJob } from './intraday';
import { CARD_DROPPED_NOTE, retryEvent, sendTestPush } from './notify';
import { createWorld, type FakePush } from './test-helpers';

// 2026-10-13 是週二。台北 09:00 = 01:00Z。
const TUE_0900 = '2026-10-13T01:00:00Z';

describe('evaluateAlert：門檻判斷', () => {
  const base = { baselinePrice: 4000, riseThresholdPercent: 1, fallThresholdPercent: 1 };
  it('上漲達門檻時觸發', () => {
    expect(evaluateAlert({ ...base, latestPrice: 4040 })).toMatchObject({ trigger: true, direction: 'up' });
  });
  it('下跌達門檻時觸發，變化為負值', () => {
    const d = evaluateAlert({ ...base, latestPrice: 3960 });
    expect(d).toMatchObject({ trigger: true, direction: 'down' });
    if (d.trigger) expect(d.changePercent).toBeCloseTo(-1, 4);
  });
  it('未達門檻時不觸發', () => {
    expect(evaluateAlert({ ...base, latestPrice: 4039.9 })).toMatchObject({ trigger: false, reason: 'below_threshold' });
    expect(evaluateAlert({ ...base, latestPrice: 3960.1 })).toMatchObject({ trigger: false });
  });
  it('沒有基準價時不觸發', () => {
    expect(evaluateAlert({ ...base, baselinePrice: null, latestPrice: 5000 })).toMatchObject({ trigger: false, reason: 'no_baseline' });
  });
  it('冷卻時間判斷', () => {
    const last = new Date('2026-10-13T01:15:00Z');
    expect(isInCooldown(last, new Date('2026-10-13T05:14:00Z'), 240)).toBe(true);
    expect(isInCooldown(last, new Date('2026-10-13T05:15:00Z'), 240)).toBe(false);
    expect(isInCooldown(null, new Date(), 240)).toBe(false);
  });
});

describe('resolveBaseline：基準價規則', () => {
  const snap = (price: number, iso: string) =>
    ({ id: 1, price, quoteTimestamp: new Date(iso) }) as unknown as Parameters<typeof resolveBaseline>[0]['firstSnapshotToday'];
  const ctx = {
    mode: 'first_valid_of_day' as const,
    intradayChecks: true,
    today: '2026-10-13',
    stored: { price: null, timestamp: null, date: null },
    firstSnapshotToday: snap(4051.2, TUE_0900),
    previousDaily: snap(4043.95, '2026-10-12T01:00:00Z'),
  };
  it('每天第一次建立時用當日首筆有效報價', () => {
    expect(resolveBaseline(ctx)).toMatchObject({ price: 4051.2, changed: true, basis: 'first_valid_of_day' });
  });
  it('同一天已建立就沿用，不會因查詢重設', () => {
    const r = resolveBaseline({ ...ctx, stored: { price: 4051.2, timestamp: new Date(TUE_0900), date: '2026-10-13' }, firstSnapshotToday: snap(9999, TUE_0900) });
    expect(r).toMatchObject({ price: 4051.2, changed: false });
  });
  it('只用每日查價時改用前一交易日參考價', () => {
    expect(resolveBaseline({ ...ctx, intradayChecks: false })).toMatchObject({ price: 4043.95, basis: 'previous_close' });
  });
  it('手動模式不自動重設', () => {
    expect(resolveBaseline({ ...ctx, mode: 'manual', stored: { price: 4000, timestamp: null, date: null } })).toMatchObject({ price: 4000, changed: false });
    expect(resolveBaseline({ ...ctx, mode: 'manual' })).toBeNull();
  });
});

describe('每日排程', () => {
  it('取得報價、存每日快照、用前一交易日計算漲跌並推播一次', async () => {
    const w = createWorld(TUE_0900);
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('success');
    expect(w.line.deliveredCount).toBe(1);
    // 推播送卡片；事件上保留同一份內容的純文字
    expect(w.line.pushes[0].card?.altText).toMatch(/^【模擬資料】💰黃金每日行情 [\d,.]+ USD [▲▼—][\d.]+%$/);
    const text = (await w.store.getEventByKey('daily:2026-10-13'))!.messageText!;
    expect(text).toContain('【模擬資料】💰黃金每日行情');
    expect(text).toMatch(/前一交易日：\d/);
    expect(text).toMatch(/^[▲▼—] [+−]?[\d,.]+ USD（[+−]?[\d.]+%）$/m);
    expect(text).toContain('https://www.truney.com/gold-chart');
    const { rows } = await w.store.listDailySnapshots({});
    expect(rows.map((s) => s.dailyDate)).toEqual(['2026-10-13', '2026-10-12']);
  });

  it('還沒到推播時間不執行', async () => {
    const w = createWorld('2026-10-13T00:30:00Z'); // 台北 08:30
    expect((await runDailyJob(w.deps(), { trigger: 'cron' })).status).toBe('not_due');
    expect(w.line.pushes).toHaveLength(0);
  });

  it('相同排程重跑（含手動）不會重複推播或重複寫入每日快照', async () => {
    const w = createWorld(TUE_0900);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    w.clock.advanceMinutes(5);
    expect((await runDailyJob(w.deps(), { trigger: 'cron' })).status).toBe('not_due');
    await runDailyJob(w.deps(), { trigger: 'manual' });
    expect(w.line.pushes).toHaveLength(1);
    const daily = (await w.store.listDailySnapshots({})).rows.filter((s) => s.dailyDate === '2026-10-13');
    expect(daily).toHaveLength(1);
  });

  it('LINE 發送失敗時記錄失敗狀態、次數與錯誤，且排程標為失敗', async () => {
    const w = createWorld(TUE_0900);
    w.line.script = [
      { ok: false, status: 500, retryable: true, error: 'LINE API 500' },
      { ok: false, status: 500, retryable: true, error: 'LINE API 500' },
      { ok: false, status: 500, retryable: true, error: 'LINE API 500' },
    ];
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('failed');
    const event = await w.store.getEventByKey('daily:2026-10-13');
    expect(event).toMatchObject({ status: 'failed', attemptCount: 3, lastError: 'LINE API 500' });
    const run = await w.store.getLastJobRun('daily');
    expect(run).toMatchObject({ status: 'failed', errorMessage: 'LINE API 500' });
  });

  it('不可重試的錯誤（例如 400）不會重試；卡片被拒時只改送一次純文字', async () => {
    const w = createWorld(TUE_0900);
    const bad = { ok: false as const, status: 400, retryable: false, error: 'LINE API 400' };
    w.line.script = [bad, bad];
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes.map((p) => (p.card ? 'card' : 'text'))).toEqual(['card', 'text']);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'failed', attemptCount: 1 });
  });

  it('逾時後重試沿用同一個 retry key，LINE 端去重所以只送達一次', async () => {
    const w = createWorld(TUE_0900);
    w.line.script = [{ ok: false, status: null, retryable: true, error: 'LINE API 逾時' }];
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(2);
    expect(w.line.pushes[0].retryKey).toBe(w.line.pushes[1].retryKey);
    expect(w.line.deliveredCount).toBe(1);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'sent', attemptCount: 2 });
  });

  it('手動重試失敗的事件會沿用 retry key', async () => {
    const w = createWorld(TUE_0900);
    w.line.script = Array.from({ length: 3 }, () => ({ ok: false as const, status: 503, retryable: true, error: 'LINE API 503' }));
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const failed = (await w.store.getEventByKey('daily:2026-10-13'))!;
    const r = await retryEvent(w.deps(), failed.id);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.event.status).toBe('sent');
    expect(new Set(w.line.pushes.map((p) => p.retryKey)).size).toBe(1);
  });

  it('LINE 尚未連線時不假裝送出，事件記為略過並保留訊息內容', async () => {
    const w = createWorld(TUE_0900);
    const deps = { ...w.deps(), line: new UnconfiguredLineClient() };
    await runDailyJob(deps, { trigger: 'cron' });
    const event = await w.store.getEventByKey('daily:2026-10-13');
    expect(event).toMatchObject({ status: 'skipped', skipReason: 'line_not_configured', sentAt: null });
    expect(event?.messageText).toContain('黃金每日行情');
    // LINE 還沒設定時，之後每 15 分鐘的排程不會一直重跑
    w.clock.advanceMinutes(15);
    expect((await runDailyJob({ ...w.deps(), line: new UnconfiguredLineClient() }, { trigger: 'cron' })).status).toBe('not_due');
    // 設定好 LINE 後，下一次排程就會補送今天的每日推播
    w.clock.advanceMinutes(15);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'sent' });
    expect(w.line.deliveredCount).toBe(1);
  });

  it('行情來源中斷時排程失敗，不寫快照也不推播', async () => {
    const w = createWorld(TUE_0900);
    const r = await runDailyJob(w.deps('error'), { trigger: 'cron' });
    expect(r.status).toBe('failed');
    expect((await w.store.listDailySnapshots({})).total).toBe(0);
    expect(w.line.pushes).toHaveLength(0);
  });

  it('報價過期時不寫入當日每日快照，訊息標示過期', async () => {
    const w = createWorld(TUE_0900);
    const r = await runDailyJob(w.deps('stale'), { trigger: 'cron' });
    expect(r.status).toBe('skipped');
    expect(await w.store.getDailySnapshot({ source: 'mock', symbol: 'MOCK:XAUUSD', currency: 'USD', unit: 'troy_oz' }, '2026-10-13')).toBeNull();
    expect(w.line.pushes[0].text).toContain('資料狀態：過期');
  });

  it('週一的前一交易日是上週五，不是日曆上的昨天', async () => {
    const w = createWorld('2026-10-12T01:00:00Z'); // 週一 09:00
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const event = await w.store.getEventByKey('daily:2026-10-12');
    const friday = await w.store.getDailySnapshot({ source: 'mock', symbol: 'MOCK:XAUUSD', currency: 'USD', unit: 'troy_oz' }, '2026-10-09');
    expect(friday).not.toBeNull();
    expect(event?.baselinePrice).toBe(friday?.price);
  });
});

describe('盤中異動提醒', () => {
  async function primeBaseline(w: ReturnType<typeof createWorld>) {
    // 這組測試用每 15 分鐘的固定間隔模式（預設是固定時間 21:30）
    await w.store.updateSettings({ intradayMode: 'interval', pollingIntervalMinutes: 15 });
    const r = await runIntradayJob(w.deps('normal'), { trigger: 'cron' });
    expect(r.status).toBe('success');
    const s = await w.store.getSettings();
    expect(s.baselineDate).toBe('2026-10-13');
    return s.baselinePrice!;
  }

  it('上漲達門檻時發送提醒', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(15);
    const r = await runIntradayJob(w.deps('surge'), { trigger: 'cron' });
    expect(r.detail).toContain('上漲提醒：已送出');
    expect(w.line.pushes.at(-1)?.text).toContain('黃金價格異動提醒');
    expect(w.line.pushes.at(-1)?.text).toContain('觸發條件：上漲 ≥ 1%');
  });

  it('下跌達門檻時發送提醒', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(15);
    const r = await runIntradayJob(w.deps('plunge'), { trigger: 'cron' });
    expect(r.detail).toContain('下跌提醒：已送出');
  });

  it('未達門檻時不發送', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(15);
    const r = await runIntradayJob(w.deps('normal'), { trigger: 'cron' });
    expect(r.detail).toContain('未觸發異動提醒');
    expect(w.line.pushes).toHaveLength(0);
  });

  it('冷卻時間內同方向不重複提醒，只記一筆冷卻事件；冷卻結束後才再提醒', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    for (let i = 0; i < 4; i++) {
      w.clock.advanceMinutes(15);
      await runIntradayJob(w.deps('surge'), { trigger: 'cron' });
    }
    expect(w.line.pushes).toHaveLength(1);
    const events = await w.store.listEvents({ types: ['alert_up'], limit: 10 });
    expect(events.filter((e) => e.skipReason === 'cooldown')).toHaveLength(1);
    w.clock.advanceMinutes(240);
    await runIntradayJob(w.deps('surge'), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(2);
  });

  it('LINE 未連線時，冷卻時間內也不會每次檢查都多記一筆提醒', async () => {
    const w = createWorld(TUE_0900);
    await w.store.updateSettings({ intradayMode: 'interval', pollingIntervalMinutes: 15 });
    const offline = () => ({ ...w.deps('surge'), line: new UnconfiguredLineClient() });
    await runIntradayJob({ ...w.deps('normal'), line: new UnconfiguredLineClient() }, { trigger: 'cron' });
    for (let i = 0; i < 3; i++) {
      w.clock.advanceMinutes(15);
      await runIntradayJob(offline(), { trigger: 'cron' });
    }
    const events = await w.store.listEvents({ types: ['alert_up'], limit: 10 });
    expect(events.filter((e) => e.skipReason === 'line_not_configured')).toHaveLength(1);
    expect(events.filter((e) => e.skipReason === 'cooldown')).toHaveLength(1);
  });

  it('同一筆報價重複處理（排程重試、重啟）不會重複提醒', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(15);
    await runIntradayJob(w.deps('surge'), { trigger: 'cron' });
    const r = await runIntradayJob(w.deps('surge'), { trigger: 'manual' });
    expect(r.detail).toContain('已處理過');
    expect(w.line.pushes).toHaveLength(1);
  });

  it('報價過期時暫停判斷，不提醒', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(15);
    const r = await runIntradayJob(w.deps('stale'), { trigger: 'cron' });
    expect(r.status).toBe('skipped');
    expect(w.line.pushes).toHaveLength(0);
  });

  it('依設定的頻率執行：未到期不跑', async () => {
    const w = createWorld(TUE_0900);
    await primeBaseline(w);
    w.clock.advanceMinutes(5);
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('not_due');
  });

  it('只用每日查價時，提醒在每日排程判斷，基準為前一交易日', async () => {
    const w = createWorld(TUE_0900);
    await w.store.updateSettings({ intradayMode: 'off' });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('disabled');
    await runDailyJob(w.deps('surge'), { trigger: 'cron' });
    const s = await w.store.getSettings();
    const prev = await w.store.getDailySnapshot({ source: 'mock', symbol: 'MOCK:XAUUSD', currency: 'USD', unit: 'troy_oz' }, '2026-10-12');
    expect(s.baselinePrice).toBe(prev?.price);
  });
});

describe('LINE 額度保護', () => {
  const sync = (over: Partial<QuotaSyncRow> = {}): QuotaSyncRow => ({
    id: 1,
    syncedAt: new Date('2026-10-13T02:00:00Z'),
    success: true,
    quotaType: 'limited',
    quotaValue: 200,
    totalUsage: 23,
    errorMessage: null,
    ...over,
  });
  const base = {
    now: new Date('2026-10-13T02:30:00Z'),
    localSentThisMonth: 21,
    monthlyMessageQuota: 200,
    quotaSafetyBuffer: 5,
    dailyEnabled: true,
  };

  it('取官方與本地剩餘的較小值，並保留每日推播額度', () => {
    const s = computeQuotaState({ ...base, latestSuccessfulSync: sync() });
    expect(s.remaining).toBe(177);
    expect(s.reserveForDaily).toBe(18 + 5);
    expect(s.canSend).toEqual({ daily: true, alert: true, test: true });
  });

  it('剩餘不足保留量時，暫停異動提醒但每日推播仍可送', () => {
    const s = computeQuotaState({ ...base, latestSuccessfulSync: sync({ totalUsage: 180 }) });
    expect(s.canSend).toEqual({ daily: true, alert: false, test: false });
    expect(s.pausedReason).toContain('保留');
  });

  it('額度用完時全部暫停', () => {
    const s = computeQuotaState({ ...base, latestSuccessfulSync: sync({ totalUsage: 200 }) });
    expect(s.canSend.daily).toBe(false);
  });

  it('無法確認官方用量時採保守策略，不假設還有免費額度', () => {
    expect(computeQuotaState({ ...base, latestSuccessfulSync: null }).canSend.daily).toBe(false);
    const old = computeQuotaState({ ...base, latestSuccessfulSync: sync({ syncedAt: new Date('2026-10-12T00:00:00Z') }) });
    expect(old.verified).toBe(false);
  });

  it('官方回報無上限時，仍以設定的方案額度為上限', () => {
    const s = computeQuotaState({ ...base, latestSuccessfulSync: sync({ quotaType: 'none', quotaValue: null, totalUsage: 199 }) });
    expect(s.remaining).toBe(1);
  });

  it('同步失敗時推播被擋下並記錄原因', async () => {
    const w = createWorld(TUE_0900);
    w.line.quotaFails = true;
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(0);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'skipped', skipReason: 'quota_unverified' });
  });

  it('測試推播也受額度保護', async () => {
    const w = createWorld(TUE_0900);
    w.line.baseUsage = 190;
    const { event: e } = await sendTestPush(w.deps());
    expect(e).toMatchObject({ status: 'skipped', skipReason: 'quota_insufficient' });
    expect(w.line.pushes).toHaveLength(0);
  });
});

describe('每日推播卡片', () => {
  const APP = 'https://gold.example';
  const CHART = `${APP}/api/chart/2026-10-13-compact.png`;
  const imageOf = (p: FakePush | undefined) => {
    const body = (p?.card?.contents as { body?: { contents?: { type: string; url?: string }[] } } | undefined)?.body?.contents ?? [];
    return body.find((n) => n.type === 'image')?.url ?? null;
  };

  it('送出卡片，走勢圖放在卡片裡（文字與圖同一則）', async () => {
    const w = createWorld(TUE_0900);
    const r = await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(r.status).toBe('success');
    expect(w.line.pushes).toHaveLength(1);
    expect(w.line.pushes[0].messages).toHaveLength(1);
    expect(imageOf(w.line.pushes[0])).toBe(CHART);
    expect(w.line.deliveredCount).toBe(1);
    expect(r.detail).toContain('（卡片＋走勢圖）');
  });

  it('卡片的數字跟事件上保存的純文字一致', async () => {
    const w = createWorld(TUE_0900);
    await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    const text = (await w.store.getEventByKey('daily:2026-10-13'))!.messageText!;
    const card = JSON.stringify(w.line.pushes[0].card);
    const change = /^[▲▼—] .+$/m.exec(text)![0];
    const prev = /^前一交易日：(.+)$/m.exec(text)![1];
    expect(card).toContain(change);
    expect(card).toContain(prev);
  });

  it('沒有公開網址或只有本機 http 時，卡片照送但沒有圖', async () => {
    for (const appUrl of [undefined, 'http://localhost:3000']) {
      const w = createWorld(TUE_0900);
      const r = await runDailyJob({ ...w.deps(), appUrl }, { trigger: 'cron' });
      expect(w.line.pushes[0].card).not.toBeNull();
      expect(imageOf(w.line.pushes[0])).toBeNull();
      expect(r.detail).toContain('（卡片）');
    }
  });

  it('LINE 拒絕卡片（400）時改送純文字，推播照常完成', async () => {
    const w = createWorld(TUE_0900);
    w.line.rejectCards = true;
    const r = await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(w.line.pushes.map((p) => (p.card ? 'card' : 'text'))).toEqual(['card', 'text']);
    expect(w.line.pushes[1].text).toContain('💰黃金每日行情');
    expect(w.line.deliveredCount).toBe(1);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'sent', lastError: CARD_DROPPED_NOTE });
    expect(r.detail).toContain('卡片被 LINE 拒絕');
  });

  it('報價過期時改送純文字（當天沒有每日快照，做不出卡片）', async () => {
    const w = createWorld(TUE_0900);
    await runDailyJob({ ...w.deps('stale'), appUrl: APP }, { trigger: 'cron' });
    expect(w.line.pushes[0].card).toBeNull();
    expect(w.line.pushes[0].text).toContain('資料狀態：過期');
  });

  it('手動重試時一樣送當天的卡片，沿用同一個 retry key', async () => {
    const w = createWorld(TUE_0900);
    const fail = { ok: false as const, status: 500, retryable: true, error: 'LINE API 500' };
    w.line.script = [fail, fail, fail];
    await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    const failed = await w.store.getEventByKey('daily:2026-10-13');
    expect(failed?.status).toBe('failed');
    const result = await retryEvent({ ...w.deps(), appUrl: APP }, failed!.id);
    expect(result.ok && result.event.status).toBe('sent');
    expect(imageOf(w.line.pushes.at(-1))).toBe(CHART);
    expect(JSON.stringify(w.line.pushes.at(-1)!.card)).toBe(JSON.stringify(w.line.pushes[0].card));
    expect(new Set(w.line.pushes.map((p) => p.retryKey)).size).toBe(1);
  });

  it('測試推播：測試文字＋每日卡片放在同一次送出', async () => {
    const w = createWorld(TUE_0900);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const { event, withCard } = await sendTestPush({ ...w.deps(), appUrl: APP });
    expect(event.status).toBe('sent');
    expect(withCard).toBe(true);
    const last = w.line.pushes.at(-1)!;
    expect(last.messages.map((m) => m.type)).toEqual(['text', 'flex']);
    expect(last.text).toContain('✅ Gold Daily 測試推播');
    expect(last.text).toContain('卡片的預覽');
    expect(imageOf(last)).toBe(CHART);
  });

  it('還沒有每日快照時，測試推播只有測試文字', async () => {
    const w = createWorld(TUE_0900);
    const { event, withCard } = await sendTestPush({ ...w.deps(), appUrl: APP });
    expect(event.status).toBe('sent');
    expect(withCard).toBe(false);
    expect(w.line.pushes[0].card).toBeNull();
    expect(w.line.pushes[0].text).not.toContain('卡片');
  });
});

describe('多位推播對象的額度', () => {
  it('每日推播保留的額度依人數計算', () => {
    const base = {
      now: new Date('2026-10-20T01:00:00Z'), // 計費月剩 11 天
      latestSuccessfulSync: { id: 1, syncedAt: new Date('2026-10-20T00:30:00Z'), success: true, quotaType: 'limited', quotaValue: 200, totalUsage: 150, errorMessage: null } as QuotaSyncRow,
      localSentThisMonth: 0,
      monthlyMessageQuota: 200,
      quotaSafetyBuffer: 5,
      dailyEnabled: true,
    };
    const one = computeQuotaState(base);
    const two = computeQuotaState({ ...base, recipients: 2 });
    expect(two.reserveForDaily - base.quotaSafetyBuffer).toBe((one.reserveForDaily - base.quotaSafetyBuffer) * 2);
    // 剩 50 則：1 人時保留 16 則還能送提醒；2 人時要保留 27 則，提醒一次用 2 則，仍可送
    expect(one.canSend.alert).toBe(true);
    expect(two.canSend.alert).toBe(true);
    const tight = computeQuotaState({ ...base, recipients: 2, latestSuccessfulSync: { ...base.latestSuccessfulSync!, totalUsage: 172 } });
    expect(tight.canSend).toMatchObject({ daily: true, alert: false, test: false });
    expect(tight.pausedReason).toContain('推播對象 2 人');
  });

  it('剩餘則數不夠送給所有人時，整則不送（不會只送一部分人）', async () => {
    const w = createWorld(TUE_0900);
    w.line.recipientCount = 2;
    w.line.baseUsage = 199;
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(0);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'skipped', skipReason: 'quota_insufficient' });
  });

  it('兩人時官方用量一次增加 2 則', async () => {
    const w = createWorld(TUE_0900);
    w.line.recipientCount = 2;
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.deliveredCount).toBe(1);
    expect((await w.line.getConsumption()).totalUsage).toBe(2);
  });
});
