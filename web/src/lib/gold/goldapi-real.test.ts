import { describe, expect, it } from 'vitest';
import { runDailyJob } from '../jobs/daily';
import { createWorld } from '../jobs/test-helpers';
import history from './__fixtures__/goldapi-history.json';
import live from './__fixtures__/goldapi-live.json';
import { GoldApiProvider } from './goldapi-provider';
import { validateQuote } from './validate';

// 用 2026-10-14 實際呼叫 GoldAPI 取得的回應（存成 fixture，不含金鑰）測試；測試本身不會呼叫 GoldAPI。

const INSTRUMENT = { symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz' as const };

function servingFixtures(overrides: { live?: unknown } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const body = url.includes('/api/history/') ? history : (overrides.live ?? live);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('GoldAPI 真實回應（2026-10-14）', () => {
  const now = () => new Date('2026-10-14T05:00:00Z');

  it('最新價：每金衡盎司的買賣中價，時間戳正確，通過驗證', async () => {
    const p = new GoldApiProvider({ apiKey: 'k', instrument: INSTRUMENT, fetchImpl: servingFixtures().impl, now });
    const q = await p.getLatestPrice();
    expect(q).toMatchObject({ price: 4166.16, symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz', source: 'goldapi', status: 'valid', isDelayed: null });
    expect(q.timestamp.toISOString()).toBe('2026-10-14T04:57:36.000Z');
    expect(live.price).toBeGreaterThan(live.bid);
    expect(live.price).toBeLessThan(live.ask);
    expect(validateQuote(q, INSTRUMENT).ok).toBe(true);
  });

  it('回應的單位不是 troy_ounce 時拒絕寫入', async () => {
    const p = new GoldApiProvider({ apiKey: 'k', instrument: INSTRUMENT, fetchImpl: servingFixtures({ live: { ...live, unit: 'gram' } }).impl, now });
    await expect(p.getLatestPrice()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('歷史資料排除週末沿用的價格，只留交易日', async () => {
    const p = new GoldApiProvider({ apiKey: 'k', instrument: INSTRUMENT, fetchImpl: servingFixtures().impl, now });
    const bars = await p.getHistoricalPrice({ from: new Date('2026-07-17T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') });
    expect(history.prices).toHaveLength(89);
    expect(bars).toHaveLength(63);
    expect(bars.some((b) => [0, 6].includes(new Date(`${b.date}T00:00:00Z`).getUTCDay()))).toBe(false);
    const dates = bars.map((b) => b.date);
    expect(dates).toContain('2026-10-09');
    expect(dates).not.toContain('2026-10-10');
    expect(dates).not.toContain('2026-10-11');
    expect(bars.at(-1)).toMatchObject({ date: '2026-10-13', price: 4182.45 });
  });

  it('完整跑一次每日推播：前一交易日取自歷史資料，訊息不標示模擬，共呼叫 2 次', async () => {
    const w = createWorld('2026-10-14T05:00:00Z'); // 台北 13:00，已過 09:00 推播時間
    const f = servingFixtures();
    const provider = new GoldApiProvider({ apiKey: 'k', instrument: INSTRUMENT, fetchImpl: f.impl, now: w.clock.now });
    const r = await runDailyJob({ ...w.deps(), provider }, { trigger: 'cron' });
    expect(r.status).toBe('success');
    const text = w.line.pushes[0].text;
    expect(text.startsWith('🥇 黃金每日行情\n2026/10/14（三）・台灣時間')).toBe(true);
    expect(text).not.toContain('模擬');
    // GoldAPI 的 XAUUSD 才會標成國際現貨黃金
    expect(text).toContain('國際現貨黃金\n4,166.16 USD / 金衡盎司');
    expect(text).toContain('▼ −16.29 USD（−0.39%）');
    expect(text).toContain('前一交易日：4,182.45 USD');
    expect(text).toContain('資料來源：GoldAPI.io');
    expect(text).toContain('資料狀態：有效');
    expect(text).toContain('📉 本次報價較前一交易日下跌 0.39%。');
    expect(f.calls).toHaveLength(2);
    expect(await w.store.countProviderCalls('goldapi', new Date('2026-10-01T00:00:00Z'))).toBe(2);
  });
});
