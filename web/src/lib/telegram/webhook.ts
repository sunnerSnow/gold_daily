import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/types';
import type { TelegramClient } from './client';
import { helpText, stoppedText, welcomeText } from './format';

// Telegram webhook：任何人私訊 bot 傳 /start 就訂閱、/stop 取消；封鎖 bot 時自動標成 blocked。
// 只處理私訊；群組與頻道要收推播，由管理者填進 TELEGRAM_CHAT_ID。
// 驗證：設定 webhook 時帶 secret_token，Telegram 每次呼叫都會放在 X-Telegram-Bot-Api-Secret-Token。
// https://core.telegram.org/bots/api#setwebhook

/**
 * webhook 的 secret 由 bot token 推導（不用另外設定環境變數）；換 token 時自動跟著換，要重新設定 webhook。
 * 只能用 A-Z a-z 0-9 _ -，hex 符合。
 */
export function telegramWebhookSecret(botToken: string): string {
  return createHmac('sha256', botToken).update('gold-daily-telegram-webhook').digest('hex');
}

export function verifyTelegramWebhookSecret(header: string | null, botToken: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(telegramWebhookSecret(botToken));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface TelegramChat {
  id?: number;
  type?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramUpdate {
  message?: { text?: string; chat?: TelegramChat };
  my_chat_member?: { chat?: TelegramChat; new_chat_member?: { status?: string } };
}

export type WebhookOutcome = 'subscribed' | 'already_subscribed' | 'unsubscribed' | 'blocked' | 'help' | 'ignored';

/** 「/start」「/start@gold_bot」「/START payload」都算 /start */
export function commandOf(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? '';
  if (!first.startsWith('/')) return null;
  return first.split('@')[0].toLowerCase();
}

export interface WebhookDeps {
  store: Store;
  telegram: TelegramClient;
}

/** 處理一則 update，回傳做了什麼（測試與紀錄用）。回覆失敗不影響訂閱狀態 */
export async function handleTelegramUpdate(deps: WebhookDeps, payload: unknown): Promise<WebhookOutcome> {
  const update = payload as TelegramUpdate;

  // 使用者封鎖 bot（kicked）：之後推播會被拒絕，先標起來，不用等到發送失敗
  const member = update?.my_chat_member;
  if (member?.chat?.type === 'private' && typeof member.chat.id === 'number' && member.new_chat_member?.status === 'kicked') {
    await deps.store.setTelegramSubscriberStatus(String(member.chat.id), 'blocked');
    return 'blocked';
  }

  const message = update?.message;
  const chat = message?.chat;
  if (!chat || chat.type !== 'private' || typeof chat.id !== 'number' || typeof message?.text !== 'string') return 'ignored';
  const chatId = String(chat.id);
  const command = commandOf(message.text);

  if (command === '/start') {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null;
    const { alreadyActive } = await deps.store.subscribeTelegram({ chatId, name, username: chat.username ?? null });
    await deps.telegram.send(chatId, { type: 'text', html: welcomeText(await deps.store.getSettings(), alreadyActive) });
    return alreadyActive ? 'already_subscribed' : 'subscribed';
  }
  if (command === '/stop') {
    await deps.store.setTelegramSubscriberStatus(chatId, 'stopped');
    await deps.telegram.send(chatId, { type: 'text', html: stoppedText() });
    return 'unsubscribed';
  }
  const current = await deps.store.getTelegramSubscriber(chatId);
  await deps.telegram.send(chatId, { type: 'text', html: helpText(current?.status === 'active') });
  return 'help';
}
