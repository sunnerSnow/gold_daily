import { describe, expect, it } from 'vitest';
import { remainingDaysInLineBillingMonth, startOfLineBillingMonth } from '../time';
import { HttpLineClient } from './client';
import { formatAlertMessage, formatDailyMessage } from './messages';

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

describe('HttpLineClient.pushText', () => {
  it('送出時帶 retry key 與 Bearer token，成功回 ok', async () => {
    const f = fakeFetch([json(200, { sentMessages: [{ id: '1' }] })]);
    const r = await new HttpLineClient('token-123', USER, f.impl).pushText('hi', 'key-1');
    expect(r).toEqual({ ok: true, duplicate: false });
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers['X-Line-Retry-Key']).toBe('key-1');
    expect(headers.Authorization).toBe('Bearer token-123');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ to: USER, messages: [{ type: 'text', text: 'hi' }] });
  });

  it('409 且已接受過同一個 retry key：視為已送出，不重送', async () => {
    const f = fakeFetch([json(409, { message: 'The retry key is already accepted' }, { 'x-line-accepted-request-id': 'abc' })]);
    expect(await new HttpLineClient('t', USER, f.impl).pushText('hi', 'k')).toEqual({ ok: true, duplicate: true });
  });

  it('5xx 可以重試；400 與 429 不重試', async () => {
    const c = (res: Response) => new HttpLineClient('t', USER, fakeFetch([res]).impl).pushText('hi', 'k');
    expect(await c(json(500, { message: 'oops' }))).toMatchObject({ ok: false, retryable: true, status: 500 });
    expect(await c(json(400, { message: 'bad' }))).toMatchObject({ ok: false, retryable: false, status: 400 });
    const r429 = await c(json(429, { message: 'You have reached your monthly limit.' }));
    expect(r429).toMatchObject({ ok: false, retryable: false, status: 429 });
    if (!r429.ok) expect(r429.error).toContain('額度');
  });

  it('逾時視為可重試（沿用 retry key 由 LINE 去重）', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const r = await new HttpLineClient('t', USER, fakeFetch([timeout]).impl).pushText('hi', 'k');
    expect(r).toMatchObject({ ok: false, retryable: true, error: 'LINE API 逾時' });
  });

  it('錯誤訊息不包含 token', async () => {
    const r = await new HttpLineClient('secret-token-xyz', USER, fakeFetch([json(401, { message: 'Authentication failed' })]).impl).pushText('hi', 'k');
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
  it('每日訊息依規格欄位排列，沒有參考價時寫無資料而不是假數字', () => {
    const text = formatDailyMessage({
      price: 4051.2,
      currency: 'USD',
      unit: 'troy_oz',
      referencePrice: null,
      changeAmount: null,
      changePercent: null,
      timestamp: new Date('2026-10-13T01:00:00Z'),
      source: 'example',
      status: 'valid',
      stale: false,
    });
    expect(text.split('\n')).toEqual([
      '黃金每日行情',
      '',
      '報價：4,051.20 USD/金衡盎司',
      '前一交易日：無資料',
      '漲跌：無法計算',
      '漲跌幅：無法計算',
      '報價時間：2026/10/13 09:00:00',
      '資料來源：example',
      '資料狀態：有效',
      '',
      '參考圖表：',
      'https://www.truney.com/gold-chart',
    ]);
  });

  it('模擬資料的訊息會明確標示', () => {
    const text = formatAlertMessage({
      direction: 'down',
      price: 3951.4,
      currency: 'USD',
      unit: 'troy_oz',
      baselinePrice: 3996.2,
      changePercent: -1.12,
      thresholdPercent: 1,
      timestamp: new Date('2026-10-07T03:00:00Z'),
      source: 'mock',
      status: 'mock',
    });
    expect(text.startsWith('【模擬資料】黃金價格異動提醒')).toBe(true);
    expect(text).toContain('觸發條件：下跌 ≥ 1%');
    expect(text).toContain('資料來源：Mock Provider（模擬資料，非真實行情）');
  });
});
