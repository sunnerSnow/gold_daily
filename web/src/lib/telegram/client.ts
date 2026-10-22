// Telegram Bot API 用戶端。Token 在網址裡（/bot<token>/方法），所以錯誤訊息一律自己組，不帶網址。
// https://core.telegram.org/bots/api

export type TelegramResult = { ok: true } | { ok: false; status: number | null; retryable: boolean; error: string };

/**
 * 送出的訊息：HTML 格式的文字，或附說明的圖片。
 * 圖片用網址，由 Telegram 的伺服器自己來抓（跟 LINE 卡片的走勢圖同一個網址）。
 */
export type TelegramMessage = { type: 'text'; html: string } | { type: 'photo'; photoUrl: string; caption: string };

export interface TelegramClient {
  readonly configured: boolean;
  /** 推播對象：chat ID（個人、群組，或頻道的 @username），依設定的順序 */
  readonly chatIds: readonly string[];
  /** 送一則訊息到一個聊天室。Telegram 沒有 LINE 的 retry key，去重要由呼叫端記錄哪些聊天室已送達 */
  send(chatId: string, message: TelegramMessage): Promise<TelegramResult>;
}

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

/** 畫面與錯誤訊息裡的聊天室名稱：頻道 @username 原樣顯示，數字 ID 只顯示末 4 碼 */
export function chatLabel(chatId: string): string {
  return chatId.startsWith('@') ? chatId : `…${chatId.slice(-4)}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { description?: string };
    return body.description ? `Telegram API ${res.status}：${body.description}` : `Telegram API ${res.status}`;
  } catch {
    return `Telegram API ${res.status}`;
  }
}

export class HttpTelegramClient implements TelegramClient {
  readonly configured = true;

  constructor(
    private readonly token: string,
    readonly chatIds: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  send(chatId: string, message: TelegramMessage): Promise<TelegramResult> {
    // https://core.telegram.org/bots/api#sendphoto
    if (message.type === 'photo') {
      return this.call('sendPhoto', { chat_id: chatId, photo: message.photoUrl, caption: message.caption, parse_mode: 'HTML' });
    }
    // https://core.telegram.org/bots/api#sendmessage（訊息裡的走勢連結不展開預覽）
    return this.call('sendMessage', { chat_id: chatId, text: message.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }

  private async call(method: 'sendMessage' | 'sendPhoto', body: unknown): Promise<TelegramResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // 逾時不代表沒送到。Telegram 沒有 retry key，重試有機會重複一則；但漏送每日行情更糟，所以照樣重試
      return { ok: false, status: null, retryable: true, error: timedOut ? 'Telegram API 逾時' : 'Telegram API 連線失敗' };
    }
    if (res.ok) return { ok: true };
    const error = await readError(res);
    // 429 是要求放慢（不是額度用完），跟 5xx 一樣可以重試；400／401／403（例如被封鎖、chat ID 錯誤）重試也沒用
    return { ok: false, status: res.status, retryable: res.status === 429 || res.status >= 500, error };
  }
}

/** 沒設定 Telegram 時使用：不會呼叫任何外部服務 */
export class UnconfiguredTelegramClient implements TelegramClient {
  readonly configured = false;
  readonly chatIds: readonly string[] = [];
  async send(): Promise<TelegramResult> {
    return { ok: false, status: null, retryable: false, error: 'Telegram 尚未設定' };
  }
}
