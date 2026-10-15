import { createHmac, timingSafeEqual } from 'node:crypto';
import { textMessage, type LineClient } from './client';

// LINE webhook：只做一件事——好友傳「ID」時，回覆對方自己的 LINE User ID，方便加入推播名單。
// 回覆（reply）不算訊息額度。不記錄、不保存任何人的 ID 或訊息內容。
// 簽章：https://developers.line.biz/en/docs/messaging-api/receiving-messages/#verify-signature

/** x-line-signature = base64(HMAC-SHA256(channel secret, 原始 request body)) */
export function verifyLineSignature(body: string, signature: string | null, channelSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 「ID」「id」「我的ID」「User ID」「LINE ID」都算（大小寫、空白、問號不影響） */
export function isIdRequest(text: string): boolean {
  const t = text.normalize('NFKC').replace(/\s+/g, '').replace(/[?？]$/, '').toLowerCase();
  return ['id', '我的id', 'userid', 'lineid', '我的userid', '我的lineid'].includes(t);
}

export function idReplyText(userId: string): string {
  return ['你的 LINE User ID：', userId, '', '把這串 ID 交給 Gold Daily 的管理者，加入推播名單後就會收到每日金價。'].join('\n');
}

interface WebhookEvent {
  type?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
}

/** 處理 webhook 送來的事件，回傳回覆了幾則 */
export async function handleWebhookEvents(line: LineClient, payload: unknown): Promise<number> {
  const events = (payload as { events?: WebhookEvent[] })?.events;
  if (!Array.isArray(events)) return 0;
  let replied = 0;
  for (const e of events) {
    const userId = e.source?.userId;
    if (e.type !== 'message' || e.message?.type !== 'text' || !e.replyToken || !userId) continue;
    if (!isIdRequest(e.message.text ?? '')) continue;
    const result = await line.reply(e.replyToken, [textMessage(idReplyText(userId))]);
    if (result.ok) replied += 1;
  }
  return replied;
}
