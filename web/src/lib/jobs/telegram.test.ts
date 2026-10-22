import { describe, expect, it } from 'vitest';
import { UnconfiguredLineClient } from '../line/client';
import type { TelegramMessage } from '../telegram/client';
import { describeEvent, runDailyJob } from './daily';
import { runIntradayJob } from './intraday';
import { canRetryEvent, NO_RECIPIENTS_NOTE, PHOTO_DROPPED_NOTE, retryEvent, sendTestPush } from './notify';
import { createWorld } from './test-helpers';

// Telegram 推播：跟 LINE 各自發送、各自記錄，一邊沒送到不影響另一邊。測試只用假的 Telegram。

// 2026-10-13 是週二。台北 09:00 = 01:00Z。
const TUE_0900 = '2026-10-13T01:00:00Z';
const APP = 'https://gold.example';
const CHART = `${APP}/api/chart/2026-10-13-compact.png`;
const KEY = 'daily:2026-10-13';

function telegramWorld() {
  const w = createWorld(TUE_0900);
  w.telegram.configured = true;
  return w;
}

const htmlOf = (m: TelegramMessage | undefined) => (m?.type === 'photo' ? m.caption : m?.html ?? '');

describe('Telegram 每日推播', () => {
  it('LINE 與 Telegram 都送：Telegram 收到走勢圖＋說明，數字跟事件上的純文字一樣', async () => {
    const w = telegramWorld();
    const r = await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(r.status).toBe('success');
    expect(w.line.deliveredCount).toBe(1);
    const [msg] = w.telegram.received('1001');
    expect(msg).toMatchObject({ type: 'photo', photoUrl: CHART });
    const text = (await w.store.getEventByKey(KEY))!.messageText!;
    expect(htmlOf(msg)).toContain(`<b>${/^[▲▼—] .+$/m.exec(text)![0]}</b>`);
    expect(htmlOf(msg)).toContain(/^前一交易日：.+$/m.exec(text)![0]);
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ status: 'sent', telegramStatus: 'sent', telegramSentTo: ['1001'], telegramAttemptCount: 1 });
    expect(r.detail).toContain('LINE 已送出（卡片＋走勢圖）・Telegram 已送出（走勢圖）');
  });

  it('沒有公開網址時 Telegram 只送說明文字', async () => {
    const w = telegramWorld();
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.telegram.received('1001')[0]).toMatchObject({ type: 'text' });
    expect(htmlOf(w.telegram.received('1001')[0])).toContain('<b>【模擬資料】💰黃金每日行情</b>');
  });

  it('Telegram 失敗不影響 LINE；排程標為失敗，下一次排程只補送 Telegram', async () => {
    const w = telegramWorld();
    const down = { ok: false as const, status: 502, retryable: true, error: 'Telegram API 502' };
    w.telegram.script = [down, down, down];
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('failed');
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ status: 'sent', telegramStatus: 'failed', telegramAttemptCount: 3, telegramLastError: 'Telegram API 502' });
    expect((await w.store.getLastJobRun('daily'))?.errorMessage).toBe('Telegram：Telegram API 502');

    w.clock.advanceMinutes(15);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(1);
    expect(w.telegram.received('1001')).toHaveLength(1);
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ telegramStatus: 'sent', telegramAttemptCount: 4 });
  });

  it('多個聊天室時，重試只送還沒收到的，已送達的不會重複', async () => {
    const w = telegramWorld();
    w.telegram.chatIds = ['1001', '@gold_channel'];
    w.telegram.failingChats.set('@gold_channel', { ok: false, status: 403, retryable: false, error: 'Telegram API 403：Forbidden: bot is not a member of the channel chat' });
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const failed = (await w.store.getEventByKey(KEY))!;
    // 403 不會自動重試
    expect(failed).toMatchObject({ telegramStatus: 'failed', telegramAttemptCount: 1, telegramSentTo: ['1001'] });
    expect(failed.telegramLastError).toContain('@gold_channel：Telegram API 403');
    expect(canRetryEvent(failed, w.clock.now())).toBe(true);

    // 把 bot 加進頻道後手動重試
    w.telegram.failingChats.clear();
    const r = await retryEvent(w.deps(), failed.id);
    expect(r.ok && r.event).toMatchObject({ telegramStatus: 'sent', telegramSentTo: ['1001', '@gold_channel'] });
    expect(w.telegram.received('1001')).toHaveLength(1);
    expect(w.telegram.received('@gold_channel')).toHaveLength(1);
    expect(w.line.pushes).toHaveLength(1);
  });

  it('Telegram 抓不到走勢圖（400）時改送同樣的說明文字，並註明', async () => {
    const w = telegramWorld();
    w.telegram.rejectPhotos = true;
    const r = await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(w.telegram.sends.map((s) => s.message.type)).toEqual(['photo', 'text']);
    expect(htmlOf(w.telegram.sends[1].message)).toBe(htmlOf(w.telegram.sends[0].message));
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ telegramStatus: 'sent', telegramLastError: PHOTO_DROPPED_NOTE });
    expect(r.detail).toContain(`Telegram 已送出（${PHOTO_DROPPED_NOTE}）`);
    expect(r.status).toBe('success');
  });

  it('只設定 Telegram 時照常推播，事件只描述 Telegram；之後的排程不會一直重跑', async () => {
    const w = telegramWorld();
    const telegramOnly = () => ({ ...w.deps(), line: new UnconfiguredLineClient(), appUrl: APP });
    const r = await runDailyJob(telegramOnly(), { trigger: 'cron' });
    expect(r.status).toBe('success');
    const event = (await w.store.getEventByKey(KEY))!;
    expect(event).toMatchObject({ status: 'skipped', skipReason: 'line_not_configured', telegramStatus: 'sent' });
    expect(describeEvent(event)).toBe('Telegram 已送出');
    w.clock.advanceMinutes(15);
    expect((await runDailyJob(telegramOnly(), { trigger: 'cron' })).status).toBe('not_due');
    expect(w.telegram.sends).toHaveLength(1);
  });

  it('當天稍晚才設定好 Telegram：下一次排程補送 Telegram，LINE 不重送', async () => {
    const w = createWorld(TUE_0900);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect((await w.store.getEventByKey(KEY))?.telegramStatus).toBeNull();
    w.telegram.configured = true;
    w.clock.advanceMinutes(15);
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(1);
    expect(w.telegram.received('1001')).toHaveLength(1);
    // 兩邊都送完後，手動執行也不會再送
    const again = await runDailyJob(w.deps(), { trigger: 'manual' });
    expect(again.detail).toContain('未重複送出');
    expect(w.telegram.sends).toHaveLength(1);
  });

  it('LINE 額度不足時 Telegram 照送', async () => {
    const w = telegramWorld();
    w.line.baseUsage = 200;
    await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.line.pushes).toHaveLength(0);
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ status: 'skipped', skipReason: 'quota_insufficient', telegramStatus: 'sent' });
  });

  it('沒設定 Telegram 時完全不碰 Telegram，事件描述跟原本一樣', async () => {
    const w = createWorld(TUE_0900);
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(w.telegram.sends).toHaveLength(0);
    expect(r.detail).toContain(`推播 ${KEY}：已送出（卡片）`);
  });
});

describe('Telegram 提醒與測試推播', () => {
  it('異動提醒送純文字，標題加粗', async () => {
    const w = telegramWorld();
    await w.store.updateSettings({ intradayMode: 'interval', pollingIntervalMinutes: 15 });
    await runIntradayJob(w.deps('normal'), { trigger: 'cron' });
    w.clock.advanceMinutes(15);
    const r = await runIntradayJob(w.deps('surge'), { trigger: 'cron' });
    expect(r.detail).toContain('上漲提醒：LINE 已送出・Telegram 已送出');
    const msg = w.telegram.received('1001').at(-1);
    expect(msg?.type).toBe('text');
    expect(htmlOf(msg)).toMatch(/^<b>【模擬資料】🔔 黃金價格異動提醒<\/b>/);
    expect(htmlOf(msg)).toContain('觸發條件：上漲 ≥ 1%');
  });

  it('測試推播：Telegram 收到測試文字＋每日行情預覽（含走勢圖）', async () => {
    const w = telegramWorld();
    await runDailyJob(w.deps(), { trigger: 'cron' });
    const { event } = await sendTestPush({ ...w.deps(), appUrl: APP });
    expect(event).toMatchObject({ status: 'sent', telegramStatus: 'sent' });
    const msg = w.telegram.received('1001').at(-1);
    expect(msg).toMatchObject({ type: 'photo', photoUrl: CHART });
    expect(htmlOf(msg)).toContain('收到這則訊息代表 Telegram 推播設定正確。');
    // LINE 的測試文字不受影響
    expect(w.line.pushes.at(-1)?.text).toContain('收到這則訊息代表 LINE 推播設定正確。');
  });
});

describe('Telegram 訂閱者', () => {
  async function subscribe(w: ReturnType<typeof createWorld>, ...ids: string[]) {
    for (const id of ids) await w.store.subscribeTelegram({ chatId: id, name: null, username: null });
  }

  it('每日推播送給固定收件人＋訂閱者；已取消的不送', async () => {
    const w = telegramWorld();
    await subscribe(w, '2001', '2002', '2003');
    await w.store.setTelegramSubscriberStatus('2003', 'stopped');
    await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(w.telegram.received('1001')).toHaveLength(1);
    expect(w.telegram.received('2001')).toHaveLength(1);
    expect(w.telegram.received('2002')).toHaveLength(1);
    expect(w.telegram.received('2003')).toHaveLength(0);
    expect((await w.store.getEventByKey(KEY))?.telegramSentTo.sort()).toEqual(['1001', '2001', '2002']);
  });

  it('訂閱者封鎖 bot（403）：標成 blocked，不算推播失敗，也不再重試', async () => {
    const w = telegramWorld();
    await subscribe(w, '2001', '2002');
    w.telegram.failingChats.set('2002', { ok: false, status: 403, retryable: false, error: 'Telegram API 403：Forbidden: bot was blocked by the user' });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('success');
    expect(await w.store.getEventByKey(KEY)).toMatchObject({ telegramStatus: 'sent', telegramLastError: null });
    expect((await w.store.getTelegramSubscriber('2002'))?.status).toBe('blocked');
  });

  it('訂閱者的聊天室已不存在（400 chat not found）：標成無法傳送；不會害後面的人收不到圖', async () => {
    const w = telegramWorld();
    await subscribe(w, ...Array.from({ length: 30 }, (_, i) => String(3000 + i)));
    w.telegram.failingChats.set('3000', { ok: false, status: 400, retryable: false, error: 'Telegram API 400：Bad Request: chat not found' });
    const r = await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(r.status).toBe('success');
    expect((await w.store.getTelegramSubscriber('3000'))?.status).toBe('blocked');
    // 3029 在第二批：還是收到圖片，沒有被誤判成「走勢圖被拒」
    expect(w.telegram.received('3029')[0]?.type).toBe('photo');
    expect((await w.store.getEventByKey(KEY))?.telegramLastError).toBeNull();
  });

  it('固定收件人送不到（403）仍算失敗，讓管理者看到', async () => {
    const w = telegramWorld();
    w.telegram.failingChats.set('1001', { ok: false, status: 403, retryable: false, error: 'Telegram API 403：Forbidden: bot was blocked by the user' });
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('failed');
    expect((await w.store.getEventByKey(KEY))?.telegramStatus).toBe('failed');
  });

  it('沒有固定收件人也沒有訂閱者：記成「沒有收件人」，不算失敗', async () => {
    const w = telegramWorld();
    w.telegram.chatIds = [];
    const r = await runDailyJob(w.deps(), { trigger: 'cron' });
    expect(r.status).toBe('success');
    const event = (await w.store.getEventByKey(KEY))!;
    expect(event).toMatchObject({ telegramStatus: 'sent', telegramSentTo: [], telegramLastError: NO_RECIPIENTS_NOTE });
    expect(describeEvent(event)).toContain('Telegram 沒有收件人');
  });

  it('訂閱者多時分批送：每批 25 個聊天室，批次之間至少隔 1 秒（Telegram 每秒約 30 則上限）', async () => {
    const w = telegramWorld();
    await subscribe(w, ...Array.from({ length: 30 }, (_, i) => String(3000 + i)));
    const sleeps: number[] = [];
    await runDailyJob({ ...w.deps(), sleep: async (ms) => void sleeps.push(ms) }, { trigger: 'cron' });
    expect(w.telegram.sends.filter((s) => s.ok)).toHaveLength(31);
    expect(sleeps).toEqual([1000]);
  });

  it('測試推播只送固定收件人，不會打擾訂閱者', async () => {
    const w = telegramWorld();
    await subscribe(w, '2001');
    await sendTestPush(w.deps());
    expect(w.telegram.received('1001')).toHaveLength(1);
    expect(w.telegram.received('2001')).toHaveLength(0);
  });

  it('只測試 Telegram：LINE 不送、不用額度，事件只描述 Telegram', async () => {
    const w = telegramWorld();
    const { event } = await sendTestPush(w.deps(), { telegramOnly: true });
    expect(w.line.pushes).toHaveLength(0);
    expect(event).toMatchObject({ status: 'skipped', skipReason: 'not_requested', telegramStatus: 'sent' });
    expect(describeEvent(event)).toBe('Telegram 已送出');
    // 重試也不會把 LINE 補送出去
    expect(canRetryEvent(event, w.clock.now())).toBe(false);
  });

  it('沒有固定收件人時，測試推播的 Telegram 這邊不送（也不記成已送出）', async () => {
    const w = telegramWorld();
    w.telegram.chatIds = [];
    await subscribe(w, '2001');
    const { event } = await sendTestPush(w.deps());
    expect(event.telegramStatus).toBeNull();
    expect(w.telegram.sends).toHaveLength(0);
  });

  it('走勢圖被拒、改送文字時，「查看黃金走勢」按鈕還在', async () => {
    const w = telegramWorld();
    w.telegram.rejectPhotos = true;
    await runDailyJob({ ...w.deps(), appUrl: APP }, { trigger: 'cron' });
    expect(w.telegram.received('1001')[0]).toMatchObject({ type: 'text', link: { label: '查看黃金走勢' } });
  });
});
