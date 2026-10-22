import { dailyFields, formatTestMessage, REFERENCE_CHART_URL, type DailyMessageInput } from '../line/messages';
import type { SettingsRow } from '../store/types';
import type { TelegramLink, TelegramMessage } from './client';

// Telegram 的訊息格式（HTML）。欄位與數字都來自 line/messages 的同一組格式化函式，跟 LINE 完全一樣；
// Telegram 不能幫文字上色，所以價格與漲跌改用粗體強調。
// https://core.telegram.org/bots/api#html-style

/** Telegram 單則文字訊息上限 4096 字 */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** 每日推播下方的按鈕，跟 LINE 卡片底部的按鈕一樣 */
export const CHART_LINK: TelegramLink = { label: '查看黃金走勢', url: REFERENCE_CHART_URL };

/** Telegram 的 HTML 只需要跳脫這三個字元 */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 純文字轉成 HTML：第一行是標題，加粗 */
function plainToHtml(text: string): string {
  const [title, ...rest] = text.slice(0, TELEGRAM_TEXT_LIMIT).split('\n');
  return [`<b>${escapeHtml(title)}</b>`, ...rest.map(escapeHtml)].join('\n');
}

/** 純文字訊息（異動提醒、到價提醒、每日推播的備案） */
export function telegramText(text: string): TelegramMessage {
  return { type: 'text', html: plainToHtml(text) };
}

/** 每日行情的說明文字；資料無效時回傳 null（改送純文字） */
export function dailyCaption(i: DailyMessageInput): string | null {
  const f = dailyFields(i);
  if (!f.valid) return null;
  const row = ([label, value]: [string, string]) =>
    `${escapeHtml(label)}：${label === '資料狀態' && f.warning ? `<b>${escapeHtml(value)}</b>` : escapeHtml(value)}`;
  return [
    `<b>${escapeHtml(f.title)}</b>`,
    ...(f.date ? [escapeHtml(f.date)] : []),
    '',
    escapeHtml(f.instrument),
    `<b>${escapeHtml(f.price)}</b> ${escapeHtml(f.unit)}`,
    ...(f.change ? [`<b>${escapeHtml(f.change)}</b>`] : []),
    '',
    ...f.rows.map(row),
  ].join('\n');
}

/**
 * 每日推播：有走勢圖時送圖片＋說明（同一則，說明在上、圖在下），沒有時只送說明文字；
 * 下方都有「查看黃金走勢」按鈕。資料無效時回傳 null
 */
export function buildDailyTelegram(i: DailyMessageInput, chartUrl: string | null): TelegramMessage | null {
  const caption = dailyCaption(i);
  if (!caption) return null;
  return chartUrl ? { type: 'photo', photoUrl: chartUrl, caption, link: CHART_LINK } : { type: 'text', html: caption, link: CHART_LINK };
}

/** 測試推播：測試文字放在最前面，後面接每日行情的預覽（有走勢圖就一起送） */
export function buildTestTelegram(now: Date, daily: TelegramMessage | null): TelegramMessage {
  const head = plainToHtml(formatTestMessage(now, false, 'Telegram'));
  if (!daily) return { type: 'text', html: head };
  const preview = '這是每日行情的預覽（最新一筆每日快照，不是即時查價）：';
  if (daily.type === 'photo') return { ...daily, caption: [head, preview, '', daily.caption].join('\n') };
  return { ...daily, html: [head, preview, '', daily.html].join('\n') };
}

// ---- 訂閱（使用者對 bot 傳 /start、/stop）的回覆 ----

const DISCLAIMER = '價格僅供參考，不構成投資建議。';

export function welcomeText(settings: Pick<SettingsRow, 'dailyPushTime' | 'skipWeekends'>, alreadyActive: boolean): string {
  if (alreadyActive) return ['<b>你已經訂閱了</b>', '不用再按一次。傳 /stop 可以取消訂閱。'].join('\n');
  return [
    '<b>✅ 已訂閱 Gold Daily</b>',
    `${settings.skipWeekends ? '每個交易日' : '每天'} ${settings.dailyPushTime}（台灣時間）會收到國際金價的每日行情（價格、漲跌與走勢圖），價格大幅變動或到達目標價時也會通知你。`,
    '',
    '傳 /stop 可以隨時取消訂閱。',
    DISCLAIMER,
  ].join('\n');
}

export function stoppedText(): string {
  return ['<b>已取消訂閱</b>', '之後不會再收到推播。想再收到時傳 /start。'].join('\n');
}

export function helpText(subscribed: boolean): string {
  return ['<b>Gold Daily 每日金價</b>', subscribed ? '你目前已訂閱。' : '你目前沒有訂閱。', '/start 訂閱每日金價', '/stop 取消訂閱'].join('\n');
}
