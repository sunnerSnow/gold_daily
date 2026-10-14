import { describe, expect, it } from 'vitest';
import { computeProviderBudget, remainingDailyRuns } from '../gold/budget';
import { checkTroyOunceUnit, GoldApiProvider } from '../gold/goldapi-provider';
import { createProvider } from '../gold/registry';
import { UnconfiguredLineClient } from '../line/client';
import { estimateMonthlyCalls, intradayDue, isTaipeiWeekend, nextCheckAt, parseCheckTimes } from '../schedule';
import { DEFAULT_SETTINGS } from '../store/types';
import { runDailyJob } from './daily';
import { runIntradayJob } from './intraday';
import { backfillHistory } from './maintenance';
import { isTargetHit } from './targets';
import { createWorld, LimitedMockProvider } from './test-helpers';

// 第 2 版功能：GoldAPI、查價次數保護、固定時間查價、週末不推播、到價提醒。

const TUE_0900 = '2026-10-13T01:00:00Z'; // 台北週二 09:00
const MOCK_KEY = { source: 'mock', symbol: 'MOCK:XAUUSD', currency: 'USD', unit: 'troy_oz' as const };

// ---------- GoldAPI ----------

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LIVE = {
  timestamp: Date.parse('2026-10-13T02:30:00Z') / 1000,
  datetime: '2026-10-13T02:30:00Z',
  metal: 'XAU',
  currency: 'USD',
  exchange: 'FOREXCOM',
  symbol: 'FOREXCOM:XAUUSD',
  price: 4072.35,
  melt_price_per_gram: { '24k': 130.93 },
};
const goldapi = (f: ReturnType<typeof fakeFetch>, apiKey: string | undefined = 'goldapi-key-xyz') =>
  new GoldApiProvider({ apiKey, instrument: { symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz' }, fetchImpl: f.impl, now: () => new Date('2026-10-13T02:30:04Z') });

describe('GoldApiProvider', () => {
  it('解析最新報價：時間戳、價格、商品，金鑰放在 x-access-token', async () => {
    const f = fakeFetch([json(200, LIVE)]);
    const q = await goldapi(f).getLatestPrice();
    expect(q).toMatchObject({ symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz', price: 4072.35, source: 'goldapi', status: 'valid', isDelayed: null });
    expect(q.timestamp.toISOString()).toBe('2026-10-13T02:30:00.000Z');
    expect(f.calls[0].url).toBe('https://www.goldapi.io/api/price/XAU/USD?currency_info=false');
    expect(f.calls[0].headers['x-access-token']).toBe('goldapi-key-xyz');
  });

  it('每金衡盎司與每公克價格對不上時拒絕（避免把公克當盎司）', async () => {
    expect(checkTroyOunceUnit(4072.35, 130.93)).toBeNull();
    expect(checkTroyOunceUnit(130.93, 130.93)).not.toBeNull();
    const f = fakeFetch([json(200, { ...LIVE, price: 130.93 })]);
    await expect(goldapi(f).getLatestPrice()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('回傳的商品不符時拒絕', async () => {
    const f = fakeFetch([json(200, { ...LIVE, metal: 'XAG' })]);
    await expect(goldapi(f).getLatestPrice()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('401、429 不重試；5xx 可重試；錯誤訊息不含金鑰', async () => {
    const e401 = await goldapi(fakeFetch([json(401, { message: 'Invalid API key' })])).getLatestPrice().catch((e) => e);
    expect(e401).toMatchObject({ retryable: false });
    expect(String(e401.message)).not.toContain('goldapi-key-xyz');
    const e429 = await goldapi(fakeFetch([json(429, { error: 'Too Many Requests' })])).getLatestPrice().catch((e) => e);
    expect(e429).toMatchObject({ retryable: false });
    expect(e429.message).toContain('額度');
    const e500 = await goldapi(fakeFetch([json(500, {})])).getLatestPrice().catch((e) => e);
    expect(e500).toMatchObject({ retryable: true });
  });

  it('歷史資料一次呼叫最多 90 天', async () => {
    const f = fakeFetch([json(200, { metal: 'XAU', currency: 'USD', from: '2026-07-16', to: '2026-10-13', prices: [{ date: '2026-10-12', price: 4043.95 }] })]);
    const bars = await goldapi(f).getHistoricalPrice({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-10-13T00:00:00Z') });
    expect(bars).toEqual([{ date: '2026-10-12', price: 4043.95, timestamp: new Date('2026-10-12T00:00:00Z') }]);
    expect(f.calls[0].url).toBe('https://www.goldapi.io/api/history/XAU/USD?from=2026-07-16&to=2026-10-13');
  });

  it('沒有金鑰或單位設成公克時顯示未設定，且不會呼叫 API', async () => {
    const f = fakeFetch([]);
    const p = goldapi(f, '');
    expect(p.getProviderStatus()).toMatchObject({ configured: false, isMock: false });
    await expect(p.getLatestPrice()).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.calls).toHaveLength(0);
    const gram = createProvider({ providerId: 'goldapi', apiKey: 'k', unit: 'gram' }).getProviderStatus();
    expect(gram.configured).toBe(false);
    expect(gram.notes[0]).toContain('troy_oz');
  });

  it('設定完成時狀態為正式來源、每月上限 100 次', () => {
    const s = createProvider({ providerId: 'goldapi', apiKey: 'k' }).getProviderStatus();
    expect(s).toMatchObject({ configured: true, isMock: false, monthlyCallQuota: 100, instrument: { symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz' } });
  });
});

// ---------- 查價次數保護 ----------

describe('查價次數保護', () => {
  it('保留 10 次緩衝，並優先保留每日推播', () => {
    expect(computeProviderBudget({ monthlyQuota: 100, used: 40, remainingDailyRuns: 14 })).toMatchObject({ cap: 90, remaining: 50, canDaily: true, canExtra: true });
    expect(computeProviderBudget({ monthlyQuota: 100, used: 76, remainingDailyRuns: 14 })).toMatchObject({ canDaily: true, canExtra: false });
    expect(computeProviderBudget({ monthlyQuota: 100, used: 90, remainingDailyRuns: 3 })).toMatchObject({ canDaily: false, canExtra: false });
    expect(computeProviderBudget({ monthlyQuota: null, used: 999, remainingDailyRuns: 30 })).toMatchObject({ limited: false, canDaily: true, canExtra: true });
  });

  it('本月剩餘每日推播次數：週末不推播時只算平日', () => {
    const tue = new Date(TUE_0900);
    // 10/13（含）到 10/31 的平日共 14 天
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: true, dailyDoneToday: false })).toBe(14);
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: true, dailyDoneToday: true })).toBe(13);
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: false, dailyDoneToday: false })).toBe(19);
  });

  it('每次呼叫都記錄；10 分鐘內查過就沿用，不再呼叫', async () => {
    const w = createWorld(TUE_0900);
    const provider = new LimitedMockProvider({ now: w.clock.now });
    const deps = { ...w.deps(), provider };
    await runDailyJob(deps, { trigger: 'cron' });
    expect(provider.latestCalls).toBe(1);
    w.clock.advanceMinutes(5);
    const r = await runIntradayJob(deps, { trigger: 'manual' });
    expect(r.detail).toContain('沿用');
    expect(provider.latestCalls).toBe(1);
    expect(await w.store.countProviderCalls('mock', new Date('2026-10-01T00:00:00Z'))).toBe(1 + provider.historyCalls);
  });

  it('額度只剩每日推播需要的量時，盤中檢查停止，但每日推播照常', async () => {
    const w = createWorld(TUE_0900);
    const provider = new LimitedMockProvider({ now: w.clock.now });
    const deps = { ...w.deps(), provider };
    // 先把本月用到只剩 14 次（10/13 起的 14 個平日）
    for (let i = 0; i < 76; i++) await w.store.recordProviderCall({ provider: 'mock', endpoint: 'latest', purpose: 'check', calledAt: new Date('2026-10-02T00:00:00Z') });
    w.clock.set('2026-10-13T13:30:00Z'); // 台北 21:30
    const check = await runIntradayJob(deps, { trigger: 'manual' });
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('保留');
    expect(provider.latestCalls).toBe(0);
    w.clock.set('2026-10-14T01:00:00Z'); // 隔天 09:00
    const daily = await runDailyJob(deps, { trigger: 'cron' });
    expect(daily.status).toBe('success');
    expect(provider.latestCalls).toBe(1);
  });

  it('LINE 發送失敗後補送不會重新查價', async () => {
    const w = createWorld(TUE_0900);
    const provider = new LimitedMockProvider({ now: w.clock.now });
    w.line.script = Array.from({ length: 3 }, () => ({ ok: false as const, status: 503, retryable: true, error: 'LINE API 503' }));
    const deps = { ...w.deps(), provider };
    await runDailyJob(deps, { trigger: 'cron' });
    const callsAfterFirst = provider.latestCalls;
    w.clock.advanceMinutes(15);
    const r = await runDailyJob(deps, { trigger: 'cron' });
    expect(r.detail).toContain('未重新查價');
    expect(provider.latestCalls).toBe(callsAfterFirst);
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'sent' });
  });

  it('行情來源中斷時，一天最多嘗試 3 次', async () => {
    const w = createWorld(TUE_0900);
    for (let i = 0; i < 3; i++) {
      await runDailyJob(w.deps('error'), { trigger: 'cron' });
      w.clock.advanceMinutes(15);
    }
    const r = await runDailyJob(w.deps('error'), { trigger: 'cron' });
    expect(r.status).toBe('not_due');
    expect(r.detail).toContain('明天再試');
  });

  it('回填只呼叫一次歷史端點', async () => {
    const w = createWorld(TUE_0900);
    const provider = new LimitedMockProvider({ now: w.clock.now });
    const r = await backfillHistory({ ...w.deps(), provider }, 90);
    expect(r.inserted).toBeGreaterThan(50);
    expect(provider.historyCalls).toBe(1);
  });
});

// ---------- 固定時間查價、週末 ----------

describe('固定時間查價與週末', () => {
  const s = { ...DEFAULT_SETTINGS, checkTimes: ['21:30'] };

  it('21:30 之前不查，21:30 之後查一次，同一時段不重複', () => {
    expect(intradayDue(s, new Date('2026-10-13T13:00:00Z'), null)).toMatchObject({ due: false }); // 21:00
    const due = intradayDue(s, new Date('2026-10-13T13:31:00Z'), new Date('2026-10-13T01:00:00Z'));
    expect(due).toMatchObject({ due: true });
    expect(intradayDue(s, new Date('2026-10-13T13:45:00Z'), new Date('2026-10-13T13:31:00Z'))).toMatchObject({ due: false, reason: '這個時段已經檢查過' });
  });

  it('週末不查價、不推播', async () => {
    expect(isTaipeiWeekend(new Date('2026-10-17T02:00:00Z'))).toBe(true); // 週六
    expect(isTaipeiWeekend(new Date('2026-10-16T15:59:00Z'))).toBe(false); // 週五 23:59
    expect(intradayDue(s, new Date('2026-10-17T13:31:00Z'), null)).toMatchObject({ due: false, reason: '週末休市，不查價' });
    const w = createWorld('2026-10-17T01:00:00Z'); // 週六 09:00
    expect((await runDailyJob(w.deps(), { trigger: 'cron' })).status).toBe('disabled');
    expect(w.line.pushes).toHaveLength(0);
  });

  it('下一次查價時間會跳過週末', () => {
    const fri = new Date('2026-10-16T14:00:00Z'); // 週五 22:00
    expect(nextCheckAt(s, fri, null)?.toISOString()).toBe('2026-10-19T13:30:00.000Z'); // 週一 21:30
  });

  it('解析檢查時間與估算每月查價次數', () => {
    expect(parseCheckTimes('21:30, 9:00')).toEqual(['09:00', '21:30']);
    expect(parseCheckTimes('25:00')).toBeNull();
    expect(estimateMonthlyCalls({ ...s, checkTimes: ['21:30'] })).toBe(44); // 22 天 × (每日 1 + 21:30)
    expect(estimateMonthlyCalls({ ...s, intradayMode: 'interval', pollingIntervalMinutes: 15 })).toBeGreaterThan(100);
  });
});

// ---------- 到價提醒 ----------

describe('到價提醒', () => {
  it('判斷是否到價', () => {
    expect(isTargetHit({ direction: 'above', targetPrice: 4000 }, 4000)).toBe(true);
    expect(isTargetHit({ direction: 'above', targetPrice: 4000 }, 3999.99)).toBe(false);
    expect(isTargetHit({ direction: 'below', targetPrice: 4000 }, 3999)).toBe(true);
    expect(isTargetHit({ direction: 'below', targetPrice: 4000 }, 4000.01)).toBe(false);
  });

  it('漲到目標價時送一則提醒並自動關閉，之後不會再送', async () => {
    const w = createWorld(TUE_0900);
    await w.store.updateSettings({ intradayMode: 'interval', pollingIntervalMinutes: 15 });
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: '測試' });
    await runIntradayJob(w.deps(), { trigger: 'cron' });
    const [t] = await w.store.listPriceTargets({ limit: 5 });
    expect(t.status).toBe('triggered');
    expect(t.eventId).not.toBeNull();
    const target = w.line.pushes.find((p) => p.text.includes('黃金到價提醒'));
    expect(target?.text).toContain('目標價格：1,000.00（漲到以上）');
    expect(target?.text).toContain('備註：測試');
    w.clock.advanceMinutes(15);
    await runIntradayJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes.filter((p) => p.text.includes('黃金到價提醒'))).toHaveLength(1);
  });

  it('還沒到價、或不同商品的目標價不觸發', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 1000, note: null });
    await w.store.insertPriceTarget({ source: 'goldapi', symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz', direction: 'above', targetPrice: 1, note: null });
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const targets = await w.store.listPriceTargets({ limit: 5 });
    expect(targets.every((t) => t.status === 'active')).toBe(true);
  });

  it('每日推播的查價也會檢查到價', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.detail).toContain('到價提醒');
    expect((await w.store.listPriceTargets({ limit: 1 }))[0].status).toBe('triggered');
  });

  it('報價過期時不觸發到價', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    await runDailyJob(w.deps('stale'), { trigger: 'cron' });
    expect((await w.store.listPriceTargets({ limit: 1 }))[0].status).toBe('active');
  });

  it('LINE 未連線時目標價仍會關閉，事件記為未發送（可到系統狀態頁重試或重新啟用）', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    await runDailyJob({ ...w.deps(), line: new UnconfiguredLineClient() }, { trigger: 'cron' });
    const [t] = await w.store.listPriceTargets({ limit: 1 });
    expect(t.status).toBe('triggered');
    expect(await w.store.getEvent(t.eventId!)).toMatchObject({ eventType: 'target', status: 'skipped', skipReason: 'line_not_configured' });
  });

  it('只有到價提醒（百分比提醒停用）時，盤中檢查仍會執行', async () => {
    const w = createWorld('2026-10-13T13:31:00Z'); // 21:31
    await w.store.updateSettings({ alertEnabled: false });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('disabled');
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 1, note: null });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('success');
  });

});
