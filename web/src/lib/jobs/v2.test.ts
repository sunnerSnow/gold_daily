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
import { isTargetHit } from './target-hits';
import { createWorld, LimitedMockProvider, type TestWorld } from './test-helpers';

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

  it('本月剩餘每日推播次數：週末不推播時只算平日，開了週六推播再加上週六', () => {
    const tue = new Date(TUE_0900);
    // 10/13（含）到 10/31 的平日共 14 天，週六 3 天（10/17、10/24、10/31）
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: true, saturdayPush: false, dailyDoneToday: false })).toBe(14);
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: true, saturdayPush: false, dailyDoneToday: true })).toBe(13);
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: true, saturdayPush: true, dailyDoneToday: false })).toBe(17);
    expect(remainingDailyRuns(tue, { dailyEnabled: true, skipWeekends: false, saturdayPush: false, dailyDoneToday: false })).toBe(19);
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

  it('週末不做盤中檢查；週日不推播，週六推播關掉時週六也不推', async () => {
    expect(isTaipeiWeekend(new Date('2026-10-17T02:00:00Z'))).toBe(true); // 週六
    expect(isTaipeiWeekend(new Date('2026-10-16T15:59:00Z'))).toBe(false); // 週五 23:59
    expect(intradayDue(s, new Date('2026-10-17T13:31:00Z'), null)).toMatchObject({ due: false, reason: '週末休市，不查價' });
    const sun = createWorld('2026-10-18T01:00:00Z'); // 週日 09:00
    expect((await runDailyJob(sun.deps(), { trigger: 'cron' })).status).toBe('disabled');
    const sat = createWorld('2026-10-17T01:00:00Z'); // 週六 09:00
    await sat.store.updateSettings({ saturdayPush: false });
    expect((await runDailyJob(sat.deps(), { trigger: 'cron' })).status).toBe('disabled');
    expect([...sun.line.pushes, ...sat.line.pushes]).toHaveLength(0);
  });

  it('週六推播：送當週收盤價（週五美國盤，雖然超過 30 分鐘沒更新也不算過期），到價也會判斷', async () => {
    const w = createWorld('2026-10-17T01:00:00Z'); // 週六 09:00（收盤後約 4 小時）
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('success');
    const card = JSON.stringify(w.line.pushes.find((p) => p.card)?.card ?? null);
    expect(card).toContain('2026/10/17（六）');
    expect(card).toContain('🎯 已達目標價 1,000.00 USD（漲到以上）');
    expect(card).not.toContain('過期');
    expect(await w.store.getDailySnapshot(MOCK_KEY, '2026-10-17')).not.toBeNull();
  });

  it('下一次查價時間會跳過週末', () => {
    const fri = new Date('2026-10-16T14:00:00Z'); // 週五 22:00
    expect(nextCheckAt(s, fri, null)?.toISOString()).toBe('2026-10-19T13:30:00.000Z'); // 週一 21:30
  });

  it('解析檢查時間與估算每月查價次數', () => {
    expect(parseCheckTimes('21:30, 9:00')).toEqual(['09:00', '21:30']);
    expect(parseCheckTimes('25:00')).toBeNull();
    expect(estimateMonthlyCalls({ ...s, checkTimes: ['21:30'], saturdayPush: false })).toBe(44); // 22 天 × (每日 1 + 21:30)
    expect(estimateMonthlyCalls({ ...s, checkTimes: ['21:30'], saturdayPush: true })).toBe(48); // 再加 4 個週六的每日推播
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

  /** 每日推播的卡片內容（JSON）；index 預設取最後一張 */
  const dailyCard = (w: TestWorld, index = -1) => JSON.stringify(w.line.pushes.filter((p) => p.card).at(index)?.card ?? null);
  /** 單獨推送的到價提醒 */
  const targetPushes = (w: TestWorld) => w.line.pushes.filter((p) => p.text.includes('黃金到價提醒'));

  it('到價寫在當天的每日推播裡，不另外推；目標價自動關閉，隔天不會再出現', async () => {
    const w = createWorld(TUE_0900);
    w.telegram.configured = true;
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: '測試' });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.detail).toContain('到價提醒（≥ 1000）併入每日推播');
    expect(targetPushes(w)).toHaveLength(0);
    const daily = w.line.pushes.find((p) => p.card);
    expect(daily?.card?.altText).toContain('🎯 已達目標價');
    expect(dailyCard(w)).toContain('🎯 已達目標價 1,000.00 USD（漲到以上）');
    expect(dailyCard(w)).toContain('備註：測試');
    expect(JSON.stringify(w.telegram.sends.map((s) => s.message))).toContain('<b>🎯 已達目標價 1,000.00 USD（漲到以上）</b>');
    const event = await w.store.getEventByKey('daily:2026-10-13');
    expect(event?.messageText).toContain('🎯 已達目標價 1,000.00 USD（漲到以上）');
    const [t] = await w.store.listPriceTargets({ limit: 5 });
    expect(t).toMatchObject({ status: 'triggered', eventId: event!.id });
    // 隔天的每日推播不會再列
    w.clock.set('2026-10-14T01:00:00Z');
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes.filter((p) => p.card)).toHaveLength(2);
    expect(dailyCard(w)).not.toContain('🎯');
  });

  it('盤中檢查不判斷到價（每日推播開著時，避免跟每日推播重覆）', async () => {
    const w = createWorld('2026-10-13T13:31:00Z'); // 21:31
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('success');
    expect(targetPushes(w)).toHaveLength(0);
    expect((await w.store.listPriceTargets({ limit: 1 }))[0].status).toBe('active');
  });

  it('同方向好幾個目標價一起達到時，只列最接近目前價格的那一個，其他註明「同時達到」並一起關閉', async () => {
    // 跌到以下：1,000,000 與 2,000,000 都達到 → 列 1,000,000；1 還沒到。漲到以上：1 與 2 都達到 → 列 2
    const w = createWorld(TUE_0900);
    for (const targetPrice of [1, 2_000_000, 1_000_000]) {
      await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice, note: null });
    }
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1, note: null });
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 2, note: '最接近' });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.detail).toContain('到價提醒（≥ 2，一併關閉 1）併入每日推播');
    expect(r.detail).toContain('到價提醒（≤ 1000000，一併關閉 2000000）併入每日推播');
    const card = dailyCard(w);
    expect(card).toContain('🎯 已達目標價 2.00 USD（漲到以上）');
    expect(card).toContain('同時達到：1.00 USD');
    expect(card).toContain('備註：最接近');
    expect(card).toContain('🎯 已達目標價 1,000,000.00 USD（跌到以下）');
    expect(card).toContain('同時達到：2,000,000.00 USD');
    expect(card).not.toContain('🎯 已達目標價 1.00 USD');
    const targets = new Map((await w.store.listPriceTargets({ limit: 10 })).map((t) => [`${t.direction}:${t.targetPrice}`, t]));
    expect(targets.get('below:1')?.status).toBe('active');
    for (const key of ['below:1000000', 'below:2000000', 'above:1', 'above:2']) expect(targets.get(key)?.status, key).toBe('triggered');
  });

  it('LINE 發送失敗後補送：卡片從資料庫重建，到價段落跟原本一樣', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 1_000_000, note: null });
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 2_000_000, note: null });
    w.line.script = Array.from({ length: 3 }, () => ({ ok: false as const, status: 503, retryable: true, error: 'LINE API 503' }));
    await runDailyJob(w.deps(), { trigger: 'cron' });
    w.clock.advanceMinutes(15);
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.detail).toContain('未重新查價');
    expect(await w.store.getEventByKey('daily:2026-10-13')).toMatchObject({ status: 'sent' });
    expect(dailyCard(w)).toContain('🎯 已達目標價 1,000,000.00 USD（跌到以下）');
    expect(dailyCard(w)).toContain('同時達到：2,000,000.00 USD');
  });

  it('還沒到價、或不同商品的目標價不觸發', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 1000, note: null });
    await w.store.insertPriceTarget({ source: 'goldapi', symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz', direction: 'above', targetPrice: 1, note: null });
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const targets = await w.store.listPriceTargets({ limit: 5 });
    expect(targets.every((t) => t.status === 'active')).toBe(true);
  });

  it('報價過期時不觸發到價', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    await runDailyJob(w.deps('stale'), { trigger: 'cron' });
    expect((await w.store.listPriceTargets({ limit: 1 }))[0].status).toBe('active');
  });

  it('LINE 未連線時目標價仍會關閉，指向未發送的每日推播事件（可到系統狀態頁重試或重新啟用）', async () => {
    const w = createWorld(TUE_0900);
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'above', targetPrice: 1000, note: null });
    await runDailyJob({ ...w.deps(), line: new UnconfiguredLineClient() }, { trigger: 'cron' });
    const [t] = await w.store.listPriceTargets({ limit: 1 });
    expect(t.status).toBe('triggered');
    expect(await w.store.getEvent(t.eventId!)).toMatchObject({ eventType: 'daily', status: 'skipped', skipReason: 'line_not_configured' });
  });

  it('每日推播停用時，改由盤中檢查判斷並單獨推一則（同樣只推最接近的）', async () => {
    const w = createWorld('2026-10-13T13:31:00Z'); // 21:31
    await w.store.updateSettings({ dailyEnabled: false });
    for (const targetPrice of [1, 2_000_000, 1_000_000]) {
      await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice, note: null });
    }
    const r = await runIntradayJob(w.deps(), { trigger: 'cron' });
    expect(r.detail).toContain('≤ 1000000，一併關閉 2000000');
    const pushes = targetPushes(w);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).toContain('目標價格：1,000,000.00 USD（跌到以下）');
    expect(pushes[0].text).toContain('同時達到：2,000,000.00 USD');
    const byPrice = new Map((await w.store.listPriceTargets({ limit: 5 })).map((t) => [t.targetPrice, t]));
    expect(byPrice.get(1_000_000)?.status).toBe('triggered');
    expect(byPrice.get(2_000_000)?.status).toBe('triggered');
    expect(byPrice.get(2_000_000)?.eventId).toBe(byPrice.get(1_000_000)?.eventId);
    expect(byPrice.get(1)?.status).toBe('active');
    // 再查一次不會補推被一併關閉的 2,000,000
    await runIntradayJob(w.deps(), { trigger: 'manual' });
    expect(targetPushes(w)).toHaveLength(1);
  });

  it('百分比提醒停用時：每日推播開著就不做盤中檢查；每日推播停用且有到價提醒才會執行', async () => {
    const w = createWorld('2026-10-13T13:31:00Z'); // 21:31
    await w.store.updateSettings({ alertEnabled: false });
    await w.store.insertPriceTarget({ ...MOCK_KEY, direction: 'below', targetPrice: 1, note: null });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('disabled');
    await w.store.updateSettings({ dailyEnabled: false });
    expect((await runIntradayJob(w.deps(), { trigger: 'cron' })).status).toBe('success');
  });

});
