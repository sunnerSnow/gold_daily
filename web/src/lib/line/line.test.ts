import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeChange } from '../gold/math';
import { formatTaipeiHour, remainingDaysInLineBillingMonth, startOfLineBillingMonth } from '../time';
import { HttpLineClient, textMessage, type LineClient, type LineMessage, type PushResult } from './client';
import { buildDailyCard, CARD_CHART_RATIO } from './flex';
import {
  formatAlertMessage,
  formatDailyMessage,
  formatTargetMessage,
  formatTestMessage,
  instrumentName,
  type DailyMessageInput,
} from './messages';
import { handleWebhookEvents, idReplyText, isIdRequest, verifyLineSignature } from './webhook';

// LINE 用戶端、訊息格式、卡片與 webhook：用假的 fetch，絕不呼叫真的 LINE。

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
const USER2 = `U${'a'.repeat(32)}`;
const hi = [textMessage('hi')];

describe('HttpLineClient.push', () => {
  it('一位推播對象：用 push，帶 retry key 與 Bearer token', async () => {
    const f = fakeFetch([json(200, { sentMessages: [{ id: '1' }] })]);
    const r = await new HttpLineClient('token-123', [USER], f.impl).push(hi, 'key-1');
    expect(r).toEqual({ ok: true, duplicate: false });
    expect(f.calls[0].url).toBe('https://api.line.me/v2/bot/message/push');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers['X-Line-Retry-Key']).toBe('key-1');
    expect(headers.Authorization).toBe('Bearer token-123');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ to: USER, messages: [{ type: 'text', text: 'hi' }] });
  });

  it('多位推播對象：用 multicast 一次送給名單上所有人，也帶 retry key', async () => {
    const f = fakeFetch([json(200, {})]);
    const c = new HttpLineClient('t', [USER, USER2], f.impl);
    expect(c.target).toBe('list');
    expect(await c.getRecipientCount()).toBe(2);
    expect(await c.push(hi, 'k')).toEqual({ ok: true, duplicate: false });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.line.me/v2/bot/message/multicast');
    expect((f.calls[0].init.headers as Record<string, string>)['X-Line-Retry-Key']).toBe('k');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ to: [USER, USER2], messages: [{ type: 'text', text: 'hi' }] });
  });

  it('所有好友：用 broadcast 群發，不需要 User ID，也帶 retry key', async () => {
    const f = fakeFetch([json(200, {})]);
    const c = new HttpLineClient('t-broadcast', 'all', f.impl);
    expect(c.target).toBe('all');
    await c.push(hi, 'k');
    expect(f.calls[0].url).toBe('https://api.line.me/v2/bot/message/broadcast');
    expect((f.calls[0].init.headers as Record<string, string>)['X-Line-Retry-Key']).toBe('k');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ messages: [{ type: 'text', text: 'hi' }] });
  });

  it('群發的人數取自 LINE 前一天（日本時間）的好友統計，並快取', async () => {
    // 台北 10/15 09:00 = 日本 10/15 10:00 → 查 10/14
    const now = () => Date.parse('2026-10-15T01:00:00Z');
    const f = fakeFetch([json(200, { status: 'ready', followers: 3, targetedReaches: 2, blocks: 1 })]);
    const c = new HttpLineClient('t-followers-1', 'all', f.impl, now);
    expect(await c.getRecipientCount()).toBe(2);
    expect(f.calls[0].url).toBe('https://api.line.me/v2/bot/insight/followers?date=20261014');
    expect(await c.getRecipientCount()).toBe(2);
    expect(f.calls).toHaveLength(1);
  });

  it('前一天的統計還沒好就看前兩天；都查不到時先算 1 人，不擋推播', async () => {
    const now = () => Date.parse('2026-10-15T01:00:00Z');
    const f = fakeFetch([json(200, { status: 'unready' }), json(200, { status: 'ready', followers: 5, blocks: 1 })]);
    expect(await new HttpLineClient('t-followers-2', 'all', f.impl, now).getRecipientCount()).toBe(4);
    expect(f.calls[1].url).toContain('date=20261013');
    const down = fakeFetch([json(500, {}), new Error('network')]);
    expect(await new HttpLineClient('t-followers-3', 'all', down.impl, now).getRecipientCount()).toBe(1);
  });

  it('回覆用 reply token，不帶 retry key', async () => {
    const f = fakeFetch([json(200, {})]);
    await new HttpLineClient('t', [], f.impl).reply('reply-token', hi);
    expect(f.calls[0].url).toBe('https://api.line.me/v2/bot/message/reply');
    expect((f.calls[0].init.headers as Record<string, string>)['X-Line-Retry-Key']).toBeUndefined();
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ replyToken: 'reply-token', messages: [{ type: 'text', text: 'hi' }] });
  });

  it('409 且已接受過同一個 retry key：視為已送出，不重送', async () => {
    const f = fakeFetch([json(409, { message: 'The retry key is already accepted' }, { 'x-line-accepted-request-id': 'abc' })]);
    expect(await new HttpLineClient('t', [USER], f.impl).push(hi, 'k')).toEqual({ ok: true, duplicate: true });
  });

  it('5xx 可以重試；400 與 429 不重試', async () => {
    const c = (res: Response) => new HttpLineClient('t', [USER], fakeFetch([res]).impl).push(hi, 'k');
    expect(await c(json(500, { message: 'oops' }))).toMatchObject({ ok: false, retryable: true, status: 500 });
    expect(await c(json(400, { message: 'bad' }))).toMatchObject({ ok: false, retryable: false, status: 400 });
    const r429 = await c(json(429, { message: 'You have reached your monthly limit.' }));
    expect(r429).toMatchObject({ ok: false, retryable: false, status: 429 });
    if (!r429.ok) expect(r429.error).toContain('額度');
  });

  it('逾時視為可重試（沿用 retry key 由 LINE 去重）', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const r = await new HttpLineClient('t', [USER], fakeFetch([timeout]).impl).push(hi, 'k');
    expect(r).toMatchObject({ ok: false, retryable: true, error: 'LINE API 逾時' });
  });

  it('錯誤訊息不包含 token', async () => {
    const r = await new HttpLineClient('secret-token-xyz', [USER], fakeFetch([json(401, { message: 'Authentication failed' })]).impl).push(hi, 'k');
    expect(JSON.stringify(r)).not.toContain('secret-token-xyz');
  });
});

describe('HttpLineClient 額度查詢', () => {
  it('解析 limited / none 與用量', async () => {
    const f = fakeFetch([json(200, { type: 'limited', value: 200 }), json(200, { type: 'none' }), json(200, { totalUsage: 23 })]);
    const c = new HttpLineClient('t', [USER], f.impl);
    expect(await c.getQuota()).toEqual({ type: 'limited', value: 200 });
    expect(await c.getQuota()).toEqual({ type: 'none', value: null });
    expect(await c.getConsumption()).toEqual({ totalUsage: 23 });
  });

  it('格式不對時丟錯，不猜數字', async () => {
    const c = new HttpLineClient('t', [USER], fakeFetch([json(200, { foo: 1 })]).impl);
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

// 2026-10-15 01:00:02Z = 台北 2026/10/15（四）09:00:02
const dailyInput = (over: Partial<DailyMessageInput> = {}): DailyMessageInput => {
  const price = over.price ?? 4139.68;
  const referencePrice = over.referencePrice === undefined ? 4161.505 : over.referencePrice;
  const change = computeChange(price, referencePrice);
  return {
    price,
    symbol: 'XAUUSD',
    currency: 'USD',
    unit: 'troy_oz',
    referencePrice,
    changeAmount: change?.amount ?? null,
    changePercent: change?.percent ?? null,
    timestamp: new Date('2026-10-15T01:00:02Z'),
    source: 'goldapi',
    status: 'valid',
    stale: false,
    ...over,
  };
};
const daily = (over: Partial<DailyMessageInput> = {}) => formatDailyMessage(dailyInput(over));

describe('每日訊息（純文字）', () => {
  it('依指定格式排列（10/15 真實數字）', () => {
    expect(daily().split('\n')).toEqual([
      '💰黃金每日行情',
      '2026/10/15（四）',
      '',
      '國際現貨黃金',
      '4,139.68 USD / 金衡盎司',
      '',
      '▼ −21.83 USD（−0.52%）',
      '',
      '前一交易日：4,161.51 USD',
      '報價時間：2026/10/15 09AM',
      '資料來源：GoldAPI.io',
      '資料狀態：有效',
      '',
      '查看黃金走勢：',
      'https://www.truney.com/gold-chart',
    ]);
  });

  it('上漲用 ▲、持平用 —（不出現 ▲ +0.00）', () => {
    expect(daily({ price: 4203.1 })).toContain('▲ +41.60 USD（+1.00%）');
    for (const price of [4161.505, 4161.509]) {
      const text = daily({ price });
      expect(text).toContain('— 0.00 USD（0.00%）');
      expect(text).not.toMatch(/[▲▼]/);
    }
  });

  it('缺少前一交易日價格：寫暫無有效資料，省略漲跌，不填假數字', () => {
    const text = daily({ referencePrice: null });
    expect(text).toContain('前一交易日：暫無有效資料');
    expect(text).toContain('4,139.68 USD / 金衡盎司');
    expect(text).not.toMatch(/[▲▼—]/);
    expect(text).not.toContain('%');
  });

  it('過期資料不標示為有效；延遲報價標示為有效（延遲報價）', () => {
    const stale = daily({ stale: true });
    expect(stale).toContain('資料狀態：過期（行情來源未更新）');
    expect(stale).not.toContain('資料狀態：有效');
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
    // UTC 10/14 17:30 = 台北 10/15（四）01:30，不能重複加 8 小時
    const text = daily({ timestamp: new Date('2026-10-14T17:30:00Z') });
    expect(text).toContain('\n2026/10/15（四）\n');
    expect(text).toContain('報價時間：2026/10/15 01:30AM');
    // UTC 10/13 16:00 = 台北 10/14（三）00:00
    const midnight = daily({ timestamp: new Date('2026-10-13T16:00:00Z') });
    expect(midnight).toContain('\n2026/10/14（三）\n');
    expect(midnight).toContain('報價時間：2026/10/14 12AM');
  });

  it('報價時間：整點寫 09AM，不是整點保留分鐘（不捨去實際時間）', () => {
    expect(formatTaipeiHour(new Date('2026-10-15T01:00:02Z'))).toBe('2026/10/15 09AM');
    expect(formatTaipeiHour(new Date('2026-10-14T05:19:34Z'))).toBe('2026/10/14 01:19PM');
    expect(formatTaipeiHour(new Date('2026-10-15T04:00:00Z'))).toBe('2026/10/15 12PM');
    expect(formatTaipeiHour(new Date('2026-10-14T16:00:00Z'))).toBe('2026/10/15 12AM');
  });

  it('只有 GoldAPI 的 XAU 報價才稱為國際現貨黃金', () => {
    const base = { symbol: 'XAUUSD', currency: 'USD', status: 'valid' as const };
    expect(instrumentName({ ...base, source: 'goldapi' })).toBe('國際現貨黃金');
    expect(instrumentName({ ...base, source: 'other-feed' })).toBe('XAUUSD');
    expect(instrumentName({ ...base, source: 'goldapi', symbol: 'XAGUSD' })).toBe('XAGUSD');
    expect(instrumentName({ ...base, source: 'goldapi', status: 'mock' })).toBe('XAUUSD（模擬資料）');
  });

  it('模擬資料會明確標示', () => {
    const text = daily({ source: 'mock', status: 'mock' });
    expect(text.startsWith('【模擬資料】💰黃金每日行情')).toBe(true);
    expect(text).toContain('XAUUSD（模擬資料）');
    expect(text).toContain('資料來源：Mock Provider（模擬資料，非真實行情）');
  });
});

type Node = { type: string; text?: string; color?: string; url?: string; aspectRatio?: string; contents?: Node[]; action?: { uri?: string; label?: string } };
const allNodes = (n: Node): Node[] => [n, ...(n.contents ?? []).flatMap(allNodes)];
const cardNodes = (card: ReturnType<typeof buildDailyCard>) => {
  const c = card!.contents as { body: Node; footer: Node };
  return [...allNodes(c.body), ...allNodes(c.footer)];
};
const textNode = (card: ReturnType<typeof buildDailyCard>, value: string) => cardNodes(card).find((n) => n.type === 'text' && n.text === value);
const CHART = 'https://gold.example/api/chart/2026-10-15-compact.png';

describe('每日卡片（Flex Message）', () => {
  it('欄位與純文字一樣；下跌綠、上漲紅、持平灰', () => {
    const down = buildDailyCard(dailyInput(), CHART);
    for (const t of ['💰黃金每日行情', '2026/10/15（四）', '國際現貨黃金', '4,139.68', 'USD / 金衡盎司', '前一交易日', '4,161.51 USD', '2026/10/15 09AM', 'GoldAPI.io', '有效']) {
      expect(textNode(down, t), t).toBeDefined();
    }
    expect(textNode(down, '▼ −21.83 USD（−0.52%）')?.color).toBe('#3B5E1F');
    expect(textNode(buildDailyCard(dailyInput({ price: 4203.1 }), CHART), '▲ +41.60 USD（+1.00%）')?.color).toBe('#B42F3A');
    expect(textNode(buildDailyCard(dailyInput({ price: 4161.505 }), CHART), '— 0.00 USD（0.00%）')?.color).toBe('#4D4D4D');
  });

  it('走勢圖在文字下方、按鈕上方；沒有圖時照常送卡片', () => {
    const card = buildDailyCard(dailyInput(), CHART)!;
    const body = (card.contents as { body: Node }).body.contents!;
    expect(body).toHaveLength(2);
    expect(body[1]).toMatchObject({ type: 'image', url: CHART, aspectRatio: CARD_CHART_RATIO });
    const footer = (card.contents as { footer: Node }).footer.contents![0];
    expect(footer.action).toMatchObject({ label: '查看黃金走勢', uri: 'https://www.truney.com/gold-chart' });
    const noChart = buildDailyCard(dailyInput(), null)!;
    expect(cardNodes(noChart).some((n) => n.type === 'image')).toBe(false);
  });

  it('通知列的替代文字有價格與漲跌幅', () => {
    expect(buildDailyCard(dailyInput(), CHART)!.altText).toBe('💰黃金每日行情 4,139.68 USD ▼0.52%');
    expect(buildDailyCard(dailyInput({ referencePrice: null }), CHART)!.altText).toBe('💰黃金每日行情 4,139.68 USD');
  });

  it('缺少前一交易日時不放漲跌；過期資料的狀態用警示色', () => {
    const noRef = buildDailyCard(dailyInput({ referencePrice: null }), CHART);
    expect(cardNodes(noRef).some((n) => /[▲▼]/.test(n.text ?? ''))).toBe(false);
    expect(textNode(noRef, '暫無有效資料')).toBeDefined();
    expect(textNode(buildDailyCard(dailyInput({ stale: true }), CHART), '過期（行情來源未更新）')?.color).toBe('#9A5B00');
  });

  it('價格無效時不做卡片（改送純文字）', () => {
    expect(buildDailyCard(dailyInput({ price: Number.NaN }), CHART)).toBeNull();
  });

  it('卡片 JSON 遠小於 LINE 的 30 KB 上限', () => {
    expect(JSON.stringify(buildDailyCard(dailyInput(), CHART)).length).toBeLessThan(10_000);
  });
});

describe('其他推播訊息', () => {
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
  });

  it('測試推播提到後面接著的卡片', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    expect(formatTestMessage(now)).not.toContain('卡片');
    expect(formatTestMessage(now, true)).toContain('下面是每日行情卡片的預覽');
    expect(formatTestMessage(now, true)).toContain('發送時間：2026/10/14 18:00:00');
  });
});

describe('webhook：好友傳「ID」取得自己的 User ID', () => {
  const SECRET = 'channel-secret-for-test';
  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64');

  it('簽章正確才接受；缺少或竄改都拒絕', () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyLineSignature(body, null, SECRET)).toBe(false);
    expect(verifyLineSignature(body, sign(body + ' '), SECRET)).toBe(false);
    expect(verifyLineSignature(body, 'not-base64!!', SECRET)).toBe(false);
  });

  it('「ID」的各種寫法都算，其他訊息不算', () => {
    for (const t of ['ID', 'id', ' Id ', '我的ID', '我的 id？', 'user id', 'LINE ID', 'ＩＤ']) expect(isIdRequest(t), t).toBe(true);
    for (const t of ['金價', 'idea', '我的ID是多少呢', '']) expect(isIdRequest(t), t).toBe(false);
  });

  it('只回覆傳「ID」的文字訊息，回覆內容是對方自己的 ID', async () => {
    const replies: { token: string; messages: LineMessage[] }[] = [];
    const line = {
      reply: async (token: string, messages: LineMessage[]): Promise<PushResult> => {
        replies.push({ token, messages });
        return { ok: true, duplicate: false };
      },
    } as unknown as LineClient;
    const count = await handleWebhookEvents(line, {
      events: [
        { type: 'message', replyToken: 'r1', source: { type: 'user', userId: USER2 }, message: { type: 'text', text: 'ID' } },
        { type: 'message', replyToken: 'r2', source: { type: 'user', userId: USER }, message: { type: 'text', text: '早安' } },
        { type: 'message', replyToken: 'r3', source: { type: 'user', userId: USER }, message: { type: 'sticker' } },
        { type: 'follow', replyToken: 'r4', source: { type: 'user', userId: USER } },
      ],
    });
    expect(count).toBe(1);
    expect(replies).toEqual([{ token: 'r1', messages: [textMessage(idReplyText(USER2))] }]);
    expect(idReplyText(USER2)).toContain(USER2);
    expect(await handleWebhookEvents(line, { nope: true })).toBe(0);
  });
});
