import { describe, expect, it } from 'vitest';
import { remainingDaysInLineBillingMonth, startOfLineBillingMonth } from '../time';
import { HttpLineClient } from './client';
import { computeChange } from '../gold/math';
import {
  formatAlertMessage,
  formatDailyMessage,
  formatTargetMessage,
  formatTestMessage,
  instrumentName,
  type DailyMessageInput,
} from './messages';

// LINE 用戶端：用假的 fetch，絕不呼叫真的 LINE。

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const USER = `U${'0'.repeat(32)}`;

describe('HttpLineClient.push', () => {
  it('送出時帶 retry key 與 Bearer token，成功回 ok', async () => {
    const f = fakeFetch([json(200, { sentMessages: [{ id: '1' }] })]);
    const r = await new HttpLineClient('token-123', USER, f.impl).push({ text: 'hi' }, 'key-1');
    expect(r).toEqual({ ok: true, duplicate: false });
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers['X-Line-Retry-Key']).toBe('key-1');
    expect(headers.Authorization).toBe('Bearer token-123');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ to: USER, messages: [{ type: 'text', text: 'hi' }] });
  });

  it('附圖片時文字與圖片放在同一次請求（只算 1 則）', async () => {
    const f = fakeFetch([json(200, { sentMessages: [{ id: '1' }, { id: '2' }] })]);
    const url = 'https://gold.example/api/chart/2026-10-14.png';
    await new HttpLineClient('t', USER, f.impl).push({ text: 'hi', imageUrl: url }, 'k');
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].init.body)).messages).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', originalContentUrl: url, previewImageUrl: url },
    ]);
  });

  it('409 且已接受過同一個 retry key：視為已送出，不重送', async () => {
    const f = fakeFetch([json(409, { message: 'The retry key is already accepted' }, { 'x-line-accepted-request-id': 'abc' })]);
    expect(await new HttpLineClient('t', USER, f.impl).push({ text: 'hi' }, 'k')).toEqual({ ok: true, duplicate: true });
  });

  it('5xx 可以重試；400 與 429 不重試', async () => {
    const c = (res: Response) => new HttpLineClient('t', USER, fakeFetch([res]).impl).push({ text: 'hi' }, 'k');
    expect(await c(json(500, { message: 'oops' }))).toMatchObject({ ok: false, retryable: true, status: 500 });
    expect(await c(json(400, { message: 'bad' }))).toMatchObject({ ok: false, retryable: false, status: 400 });
    const r429 = await c(json(429, { message: 'You have reached your monthly limit.' }));
    expect(r429).toMatchObject({ ok: false, retryable: false, status: 429 });
    if (!r429.ok) expect(r429.error).toContain('額度');
  });

  it('逾時視為可重試（沿用 retry key 由 LINE 去重）', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const r = await new HttpLineClient('t', USER, fakeFetch([timeout]).impl).push({ text: 'hi' }, 'k');
    expect(r).toMatchObject({ ok: false, retryable: true, error: 'LINE API 逾時' });
  });

  it('錯誤訊息不包含 token', async () => {
    const r = await new HttpLineClient('secret-token-xyz', USER, fakeFetch([json(401, { message: 'Authentication failed' })]).impl).push({ text: 'hi' }, 'k');
    expect(JSON.stringify(r)).not.toContain('secret-token-xyz');
  });
});

describe('HttpLineClient 額度查詢', () => {
  it('解析 limited / none 與用量', async () => {
    const f = fakeFetch([json(200, { type: 'limited', value: 200 }), json(200, { type: 'none' }), json(200, { totalUsage: 23 })]);
    const c = new HttpLineClient('t', USER, f.impl);
    expect(await c.getQuota()).toEqual({ type: 'limited', value: 200 });
    expect(await c.getQuota()).toEqual({ type: 'none', value: null });
    expect(await c.getConsumption()).toEqual({ totalUsage: 23 });
  });

  it('格式不對時丟錯，不猜數字', async () => {
    const c = new HttpLineClient('t', USER, fakeFetch([json(200, { foo: 1 })]).impl);
    await expect(c.getQuota()).rejects.toThrow();
  });
});

describe('LINE 計費月份（日本時間）', () => {
  it('台灣時間月底 23:00 之後算下個月', () => {
    // 台灣 10/31 22:59 = 日本 10/31 23:59 → 還是 10 月
    expect(startOfLineBillingMonth(new Date('2026-10-31T14:59:00Z')).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    // 台灣 10/31 23:00 = 日本 11/1 00:00 → 11 月
    expect(startOfLineBillingMonth(new Date('2026-10-31T15:00:00Z')).toISOString()).toBe('2026-10-31T15:00:00.000Z');
  });

  it('本月剩餘天數', () => {
    expect(remainingDaysInLineBillingMonth(new Date('2026-10-13T02:30:00Z'))).toBe(18);
  });
});

describe('推播訊息格式', () => {
  // 2026-10-14 05:19:34Z = 台北 2026/10/14（三）13:19:34
  const daily = (over: Partial<DailyMessageInput> = {}): string => {
    const price = over.price ?? 4161.51;
    const referencePrice = over.referencePrice === undefined ? 4182.45 : over.referencePrice;
    const change = computeChange(price, referencePrice);
    return formatDailyMessage({
      price,
      symbol: 'XAUUSD',
      currency: 'USD',
      unit: 'troy_oz',
      referencePrice,
      changeAmount: change?.amount ?? null,
      changePercent: change?.percent ?? null,
      timestamp: new Date('2026-10-14T05:19:34Z'),
      source: 'goldapi',
      status: 'valid',
      stale: false,
      ...over,
    });
  };

  it('下跌：依規格排列，最新價格醒目、漲跌金額與幅度同一行', () => {
    expect(daily().split('\n')).toEqual([
      '🥇 黃金每日行情',
      '2026/10/14（三）・台灣時間',
      '',
      '國際現貨黃金',
      '4,161.51 USD / 金衡盎司',
      '',
      '▼ −20.94 USD（−0.50%）',
      '',
      '前一交易日：4,182.45 USD',
      '報價時間：2026/10/14 13:19:34',
      '資料來源：GoldAPI.io',
      '資料狀態：有效',
      '',
      '📉 本次報價較前一交易日下跌 0.50%。',
      '',
      '查看黃金走勢：',
      'https://www.truney.com/gold-chart',
    ]);
  });

  it('上漲：用 ▲ 與上漲摘要', () => {
    const text = daily({ price: 4203.1 });
    expect(text).toContain('▲ +20.65 USD（+0.49%）');
    expect(text).toContain('📈 本次報價較前一交易日上漲 0.49%。');
    expect(text).not.toContain('▼');
  });

  it('持平：用 —，不出現 ▲ +0.00', () => {
    for (const price of [4182.45, 4182.454]) {
      const text = daily({ price });
      expect(text).toContain('— 0.00 USD（0.00%）');
      expect(text).toContain('➖ 本次報價與前一交易日持平。');
      expect(text).not.toMatch(/[▲▼]/);
    }
  });

  it('漲跌幅不到 0.01% 時，摘要不寫成 0.00%', () => {
    expect(daily({ price: 4182.55 })).toContain('上漲不到 0.01%');
  });

  it('缺少前一交易日價格：寫暫無有效資料，省略漲跌與摘要，不填假數字', () => {
    const text = daily({ referencePrice: null });
    expect(text).toContain('前一交易日：暫無有效資料');
    expect(text).toContain('4,161.51 USD / 金衡盎司');
    expect(text).not.toMatch(/[▲▼📈📉➖]/u);
    expect(text).not.toContain('0.00%');
  });

  it('過期資料不標示為有效，並提醒漲跌只反映該筆報價', () => {
    const text = daily({ stale: true });
    expect(text).toContain('資料狀態：過期（行情來源未更新）');
    expect(text).not.toContain('資料狀態：有效');
    expect(text).toContain('⚠️ 行情來源未更新');
    expect(text).not.toContain('📉');
  });

  it('延遲報價標示為有效（延遲報價）', () => {
    expect(daily({ status: 'delayed' })).toContain('資料狀態：有效（延遲報價）');
  });

  it('價格無效時只顯示暫無有效資料與異常狀態', () => {
    for (const price of [0, Number.NaN, -5]) {
      const text = daily({ price });
      expect(text).toContain('\n暫無有效資料\n');
      expect(text).toContain('資料狀態：異常（報價無效）');
      expect(text).not.toContain('前一交易日');
      expect(text).not.toContain('國際現貨黃金');
    }
  });

  it('台灣時區：依時間戳換算一次，跨日時日期與星期一起變', () => {
    // UTC 10/14 17:30 = 台北 10/15（四）01:30，不能重複加 8 小時變成 09:30
    const text = daily({ timestamp: new Date('2026-10-14T17:30:00Z') });
    expect(text).toContain('2026/10/15（四）・台灣時間');
    expect(text).toContain('報價時間：2026/10/15 01:30:00');
    // UTC 10/13 16:00 = 台北 10/14（三）00:00
    const midnight = daily({ timestamp: new Date('2026-10-13T16:00:00Z') });
    expect(midnight).toContain('2026/10/14（三）・台灣時間');
    expect(midnight).toContain('報價時間：2026/10/14 00:00:00');
  });

  it('只有 GoldAPI 的 XAU 報價才稱為國際現貨黃金', () => {
    const base = { symbol: 'XAUUSD', currency: 'USD', status: 'valid' as const };
    expect(instrumentName({ ...base, source: 'goldapi' })).toBe('國際現貨黃金');
    expect(instrumentName({ ...base, source: 'other-feed' })).toBe('XAUUSD');
    expect(instrumentName({ ...base, source: 'goldapi', symbol: 'XAGUSD' })).toBe('XAGUSD');
    expect(instrumentName({ ...base, source: 'goldapi', status: 'mock' })).toBe('XAUUSD（模擬資料）');
  });

  it('模擬資料的每日訊息會明確標示', () => {
    const text = daily({ source: 'mock', status: 'mock' });
    expect(text.startsWith('【模擬資料】🥇 黃金每日行情')).toBe(true);
    expect(text).toContain('XAUUSD（模擬資料）');
    expect(text).not.toContain('國際現貨黃金');
    expect(text).toContain('資料來源：Mock Provider（模擬資料，非真實行情）');
  });

  it('異動提醒保留原本欄位，改用共用的價格與箭頭格式', () => {
    const text = formatAlertMessage({
      direction: 'down',
      price: 3951.4,
      symbol: 'XAUUSD',
      currency: 'USD',
      unit: 'troy_oz',
      baselinePrice: 3996.2,
      changePercent: -1.12,
      thresholdPercent: 1,
      timestamp: new Date('2026-10-07T03:00:00Z'),
      source: 'mock',
      status: 'mock',
    });
    expect(text.startsWith('【模擬資料】🔔 黃金價格異動提醒')).toBe(true);
    expect(text).toContain('目前價格：3,951.40 USD / 金衡盎司');
    expect(text).toContain('參考價格：3,996.20 USD');
    expect(text).toContain('價格變化：▼ −1.12%');
    expect(text).toContain('觸發條件：下跌 ≥ 1%');
    expect(text).toContain('觸發時間：2026/10/07 11:00:00');
    expect(text).toContain('資料來源：Mock Provider（模擬資料，非真實行情）');
    expect(text).toContain('查看黃金走勢：\nhttps://www.truney.com/gold-chart');
  });

  it('到價提醒保留目標價與備註', () => {
    const text = formatTargetMessage({
      direction: 'above',
      price: 4210,
      targetPrice: 4200,
      symbol: 'XAUUSD',
      currency: 'USD',
      unit: 'troy_oz',
      timestamp: new Date('2026-10-14T13:30:00Z'),
      source: 'goldapi',
      status: 'valid',
      note: '加碼',
    });
    expect(text.split('\n').slice(0, 2)).toEqual(['🎯 黃金到價提醒', '國際現貨黃金']);
    expect(text).toContain('目標價格：4,200.00 USD（漲到以上）');
    expect(text).toContain('備註：加碼');
    expect(text).toContain('報價時間：2026/10/14 21:30:00');
  });

  it('測試推播可附上每日行情的格式預覽', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    expect(formatTestMessage(now)).not.toContain('格式預覽');
    const withPreview = formatTestMessage(now, daily());
    expect(withPreview).toContain('發送時間：2026/10/14 18:00:00');
    expect(withPreview).toContain('格式預覽');
    expect(withPreview).toContain('🥇 黃金每日行情');
  });
});
