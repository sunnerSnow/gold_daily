import { dailyFields, formatTestMessage, REFERENCE_CHART_URL, type DailyMessageInput } from '../line/messages';
import type { TelegramMessage } from './client';

// Telegram 的訊息格式（HTML）。欄位與數字都來自 line/messages 的同一組格式化函式，跟 LINE 完全一樣；
// Telegram 不能幫文字上色，所以價格與漲跌改用粗體強調。
// https://core.telegram.org/bots/api#html-style

/** Telegram 單則文字訊息上限 4096 字 */
export const TELEGRAM_TEXT_LIMIT = 4096;

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
    '',
    `<a href="${REFERENCE_CHART_URL}">查看黃金走勢</a>`,
  ].join('\n');
}

/** 每日推播：有走勢圖時送圖片＋說明（同一則），沒有時只送說明文字；資料無效時回傳 null */
export function buildDailyTelegram(i: DailyMessageInput, chartUrl: string | null): TelegramMessage | null {
  const caption = dailyCaption(i);
  if (!caption) return null;
  return chartUrl ? { type: 'photo', photoUrl: chartUrl, caption } : { type: 'text', html: caption };
}

/** 測試推播：測試文字放在最前面，後面接每日行情的預覽（有走勢圖就一起送） */
export function buildTestTelegram(now: Date, daily: TelegramMessage | null): TelegramMessage {
  const head = plainToHtml(formatTestMessage(now, false, 'Telegram'));
  if (!daily) return { type: 'text', html: head };
  const preview = '這是每日行情的預覽（最新一筆每日快照，不是即時查價）：';
  if (daily.type === 'photo') return { ...daily, caption: [head, preview, '', daily.caption].join('\n') };
  return { type: 'text', html: [head, preview, '', daily.html].join('\n') };
}
