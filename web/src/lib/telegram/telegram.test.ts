import { describe, expect, it } from 'vitest';
import { computeChange } from '../gold/math';
import { safeErrorMessage } from '../jobs/deps';
import { formatDailyMessage, type DailyMessageInput } from '../line/messages';
import { chatLabel, HttpTelegramClient } from './client';
import { buildDailyTelegram, buildTestTelegram, dailyCaption, escapeHtml, telegramText } from './format';

// Telegram 用戶端與訊息格式：用假的 fetch，絕不呼叫真的 Telegram。

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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TOKEN = '123456:ABC-secret_token';
const body = (init: RequestInit) => JSON.parse(String(init.body));

describe('HttpTelegramClient.send', () => {
  it('文字：sendMessage，HTML 格式、不展開連結預覽', async () => {
    const f = fakeFetch([json(200, { ok: true, result: { message_id: 1 } })]);
    const r = await new HttpTelegramClient(TOKEN, ['1001'], f.impl).send('1001', { type: 'text', html: '<b>hi</b>' });
    expect(r).toEqual({ ok: true });
    expect(f.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(body(f.calls[0].init)).toEqual({ chat_id: '1001', text: '<b>hi</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  it('圖片：sendPhoto，圖片用網址、說明用 HTML', async () => {
    const f = fakeFetch([json(200, { ok: true })]);
    await new HttpTelegramClient(TOKEN, ['@gold_channel'], f.impl).send('@gold_channel', { type: 'photo', photoUrl: 'https://gold.example/c.png', caption: '<b>x</b>' });
    expect(f.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    expect(body(f.calls[0].init)).toEqual({ chat_id: '@gold_channel', photo: 'https://gold.example/c.png', caption: '<b>x</b>', parse_mode: 'HTML' });
  });

  it('403（被封鎖）、400 不重試；429 與 5xx 可以重試；錯誤訊息帶 Telegram 的說明、不帶 token', async () => {
    const f = fakeFetch([
      json(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
      json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      json(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }),
      json(502, {}),
    ]);
    const c = new HttpTelegramClient(TOKEN, ['1'], f.impl);
    const text = { type: 'text', html: 'x' } as const;
    const blocked = await c.send('1', text);
    expect(blocked).toEqual({ ok: false, status: 403, retryable: false, error: 'Telegram API 403：Forbidden: bot was blocked by the user' });
    expect(await c.send('1', text)).toMatchObject({ ok: false, status: 400, retryable: false });
    expect(await c.send('1', text)).toMatchObject({ ok: false, status: 429, retryable: true });
    expect(await c.send('1', text)).toEqual({ ok: false, status: 502, retryable: true, error: 'Telegram API 502' });
    expect(JSON.stringify(blocked)).not.toContain('secret');
  });

  it('逾時與連線失敗可以重試，錯誤訊息不帶網址（網址裡有 token）', async () => {
    const timeout = Object.assign(new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage timed out`), { name: 'TimeoutError' });
    const f = fakeFetch([timeout, new TypeError('fetch failed')]);
    const c = new HttpTelegramClient(TOKEN, ['1'], f.impl);
    expect(await c.send('1', { type: 'text', html: 'x' })).toEqual({ ok: false, status: null, retryable: true, error: 'Telegram API 逾時' });
    expect(await c.send('1', { type: 'text', html: 'x' })).toEqual({ ok: false, status: null, retryable: true, error: 'Telegram API 連線失敗' });
  });

  it('寫進資料庫的錯誤訊息會遮掉 Telegram token', () => {
    expect(safeErrorMessage(new Error(`GET https://api.telegram.org/bot${TOKEN}/getMe failed`))).toBe('GET https://api.telegram.org/bot***/getMe failed');
  });

  it('聊天室名稱：頻道 @username 原樣顯示，數字 ID 只顯示末 4 碼', () => {
    expect(chatLabel('@gold_channel')).toBe('@gold_channel');
    expect(chatLabel('-1001234567890')).toBe('…7890');
  });
});

describe('Telegram 訊息格式', () => {
  const ts = new Date('2026-10-15T01:00:00Z');
  const change = computeChange(4139.68, 4161.51)!;
  const input: DailyMessageInput = {
    price: 4139.68,
    symbol: 'XAUUSD',
    currency: 'USD',
    unit: 'troy_oz',
    referencePrice: 4161.51,
    changeAmount: change.amount,
    changePercent: change.percent,
    timestamp: ts,
    source: 'goldapi',
    status: 'valid',
    stale: false,
  };

  it('HTML 只跳脫 & < >', () => {
    expect(escapeHtml('a < b & c > d "e"')).toBe('a &lt; b &amp; c &gt; d "e"');
  });

  it('每日說明：數字跟純文字版一樣，價格與漲跌加粗，附走勢連結', () => {
    const caption = dailyCaption(input)!;
    const plain = formatDailyMessage(input);
    const changeLine = /^[▲▼—] .+$/m.exec(plain)![0];
    expect(caption).toContain(`<b>${changeLine}</b>`);
    expect(caption).toContain('<b>4,139.68</b> USD / 金衡盎司');
    expect(caption).toContain('前一交易日：4,161.51 USD');
    expect(caption).toContain('<b>💰黃金每日行情</b>');
    expect(caption).toContain('<a href="https://www.truney.com/gold-chart">查看黃金走勢</a>');
  });

  it('過期資料的「資料狀態」加粗提醒', () => {
    expect(dailyCaption({ ...input, stale: true })).toContain('資料狀態：<b>過期（行情來源未更新）</b>');
  });

  it('有走勢圖送圖片＋說明，沒有就只送說明；報價無效時不做（改送純文字）', () => {
    expect(buildDailyTelegram(input, 'https://gold.example/c.png')).toMatchObject({ type: 'photo', photoUrl: 'https://gold.example/c.png' });
    expect(buildDailyTelegram(input, null)).toMatchObject({ type: 'text' });
    expect(buildDailyTelegram({ ...input, price: 0 }, null)).toBeNull();
  });

  it('純文字訊息：第一行加粗，內容會跳脫', () => {
    expect(telegramText('🔔 標題\n價格 < 4,000 & 上漲')).toEqual({ type: 'text', html: '<b>🔔 標題</b>\n價格 &lt; 4,000 &amp; 上漲' });
  });

  it('測試推播：測試文字在前、每日行情預覽在後；有圖時一起送', () => {
    const daily = buildDailyTelegram(input, 'https://gold.example/c.png')!;
    const t = buildTestTelegram(ts, daily);
    expect(t.type).toBe('photo');
    if (t.type !== 'photo') return;
    expect(t.caption.startsWith('<b>✅ Gold Daily 測試推播</b>')).toBe(true);
    expect(t.caption).toContain('收到這則訊息代表 Telegram 推播設定正確。');
    expect(t.caption).toContain('<b>💰黃金每日行情</b>');
    expect(buildTestTelegram(ts, null)).toMatchObject({ type: 'text' });
  });
});
