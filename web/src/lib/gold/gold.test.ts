import { describe, expect, it } from 'vitest';
import { computeChange, fallPercent, risePercent } from './math';
import { MOCK_INSTRUMENT, MockGoldPriceProvider } from './mock-provider';
import { createProvider } from './registry';
import { ProviderError } from './types';
import { isStale, validateQuote } from './validate';

const NOW = new Date('2026-10-13T02:42:00Z'); // 台北 10:42（週二）

function quote(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD',
    price: 4072.35,
    currency: 'USD',
    unit: 'troy_oz',
    source: 'example',
    timestamp: new Date('2026-10-13T02:30:00Z'),
    fetchedAt: new Date('2026-10-13T02:30:04Z'),
    isDelayed: false,
    status: 'valid',
    ...overrides,
  };
}
const EXPECTED = { symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz' as const };

describe('validateQuote：解析行情資料', () => {
  it('正常的報價可以通過驗證', () => {
    const r = validateQuote(quote(), EXPECTED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote.price).toBe(4072.35);
  });

  it.each([
    ['價格為 0', { price: 0 }],
    ['價格為負數', { price: -1 }],
    ['價格不是數字', { price: Number.NaN }],
    ['價格是字串', { price: '4072.35' }],
    ['沒有時間戳', { timestamp: undefined }],
  ])('%s 會被拒絕', (_label, overrides) => {
    expect(validateQuote(quote(overrides), EXPECTED).ok).toBe(false);
  });

  it('商品代號、幣別或單位不符時拒絕，不混算不同商品', () => {
    expect(validateQuote(quote({ symbol: 'XAGUSD' }), EXPECTED)).toMatchObject({ ok: false });
    expect(validateQuote(quote({ currency: 'TWD' }), EXPECTED)).toMatchObject({ ok: false });
    // 美元／金衡盎司不能當成公克
    expect(validateQuote(quote({ unit: 'gram' }), EXPECTED)).toMatchObject({ ok: false });
  });

  it('報價時間比取得時間晚太多，視為時間戳錯誤', () => {
    const r = validateQuote(quote({ timestamp: new Date('2026-10-13T03:30:00Z') }), EXPECTED);
    expect(r.ok).toBe(false);
  });
});

describe('isStale：舊資料與過期判斷', () => {
  const ts = new Date('2026-10-13T02:30:00Z');
  it('30 分鐘內是新的', () => {
    expect(isStale(ts, new Date('2026-10-13T02:59:00Z'), 30)).toBe(false);
  });
  it('超過 30 分鐘就過期', () => {
    expect(isStale(ts, new Date('2026-10-13T03:01:00Z'), 30)).toBe(true);
  });
});

describe('computeChange：漲跌計算', () => {
  it('依公式計算差額與百分比', () => {
    const c = computeChange(4072.35, 4043.95);
    expect(c?.amount).toBeCloseTo(28.4, 4);
    expect(c?.percent).toBeCloseTo(0.7023, 3);
  });

  it.each([
    ['參考價不存在', 4072.35, null],
    ['參考價為 0', 4072.35, 0],
    ['參考價為負', 4072.35, -10],
    ['參考價為 NaN', 4072.35, Number.NaN],
    ['目前價格無效', 0, 4043.95],
  ])('%s 時不產生漲跌幅', (_label, current, reference) => {
    expect(computeChange(current as number, reference as number | null)).toBeNull();
  });

  it('上漲／下跌幅度公式', () => {
    expect(risePercent(4091.71, 4051.2)).toBeCloseTo(1, 2);
    expect(fallPercent(4010.69, 4051.2)).toBeCloseTo(1, 2);
    expect(risePercent(4051.2, 0)).toBeNull();
  });
});

describe('MockGoldPriceProvider', () => {
  it('回傳的報價明確標示為 mock，且通過自己的商品驗證', async () => {
    const p = new MockGoldPriceProvider({ now: () => NOW });
    const q = await p.getLatestPrice();
    expect(q.status).toBe('mock');
    expect(q.symbol).toBe('MOCK:XAUUSD');
    expect(q.source).toBe('mock');
    expect(validateQuote(q, MOCK_INSTRUMENT).ok).toBe(true);
    expect(p.getProviderStatus()).toMatchObject({ isMock: true, licensed: false, configured: true });
  });

  it('同一分鐘內重複呼叫得到相同報價（方便去重）', async () => {
    const p = new MockGoldPriceProvider({ now: () => NOW });
    const a = await p.getLatestPrice();
    const b = await p.getLatestPrice();
    expect(a.price).toBe(b.price);
    expect(a.timestamp.getTime()).toBe(b.timestamp.getTime());
  });

  it('急漲、急跌情境比正常價高或低 1.5%', async () => {
    const normal = await new MockGoldPriceProvider({ now: () => NOW }).getLatestPrice();
    const surge = await new MockGoldPriceProvider({ now: () => NOW, scenario: 'surge' }).getLatestPrice();
    const plunge = await new MockGoldPriceProvider({ now: () => NOW, scenario: 'plunge' }).getLatestPrice();
    expect(risePercent(surge.price, normal.price)).toBeCloseTo(1.5, 1);
    expect(fallPercent(plunge.price, normal.price)).toBeCloseTo(1.5, 1);
  });

  it('來源中斷時丟出錯誤，不回傳預設價格', async () => {
    const p = new MockGoldPriceProvider({ now: () => NOW, scenario: 'error' });
    await expect(p.getLatestPrice()).rejects.toBeInstanceOf(ProviderError);
  });

  it('來源未更新時報價時間是舊的', async () => {
    const q = await new MockGoldPriceProvider({ now: () => NOW, scenario: 'stale' }).getLatestPrice();
    expect(isStale(q.timestamp, NOW, 30)).toBe(true);
  });

  it('週末休市時報價停在週六清晨，判定為過期', async () => {
    const sunday = new Date('2026-10-18T02:00:00Z'); // 台北週日 10:00
    const q = await new MockGoldPriceProvider({ now: () => sunday }).getLatestPrice();
    expect(isStale(q.timestamp, sunday, 30)).toBe(true);
  });

  it('歷史資料只有平日，且不超過現在', async () => {
    const p = new MockGoldPriceProvider({ now: () => NOW });
    const bars = await p.getHistoricalPrice({ from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') });
    expect(bars.map((b) => b.date)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13',
    ]);
  });
});

describe('createProvider：Mock 與正式來源要能明確區分', () => {
  it('mock 會建立 Mock Provider', () => {
    expect(createProvider({ providerId: 'mock' }).getProviderStatus().isMock).toBe(true);
  });

  it('沒設定或不支援的來源顯示「尚未設定正式行情來源」，不會偷用 Mock', async () => {
    for (const id of [undefined, '', 'tradingview']) {
      const p = createProvider({ providerId: id });
      const s = p.getProviderStatus();
      expect(s).toMatchObject({ configured: false, isMock: false, licensed: false });
      expect(s.name).toBe('尚未設定正式行情來源');
      await expect(p.getLatestPrice()).rejects.toMatchObject({ code: 'not_configured' });
    }
  });
});
