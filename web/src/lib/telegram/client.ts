// Telegram Bot API 用戶端。Token 在網址裡（/bot<token>/方法），所以錯誤訊息一律自己組，不帶網址。
// https://core.telegram.org/bots/api

export type TelegramResult = { ok: true } | { ok: false; status: number | null; retryable: boolean; error: string };

/** 訊息下方的連結按鈕（跟 LINE 卡片底部的「查看黃金走勢」一樣） */
export interface TelegramLink {
  label: string;
  url: string;
}

/**
 * 送出的訊息：HTML 格式的文字，或附說明的圖片。
 * 圖片用網址，由 Telegram 的伺服器自己來抓（跟 LINE 卡片的走勢圖同一個網址）。
 */
export type TelegramMessage =
  | { type: 'text'; html: string; link?: TelegramLink }
  | { type: 'photo'; photoUrl: string; caption: string; link?: TelegramLink };

export interface TelegramWebhookInfo {
  /** 目前設定的 webhook 網址；沒設定時是空字串 */
  url: string;
  pendingUpdateCount: number;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
}

export interface TelegramClient {
  readonly configured: boolean;
  /** 固定收件人（TELEGRAM_CHAT_ID）：個人、群組或頻道。測試推播只送這些；訂閱者另外存在資料庫 */
  readonly chatIds: readonly string[];
  /** 送一則訊息到一個聊天室。Telegram 沒有 LINE 的 retry key，去重要由呼叫端記錄哪些聊天室已送達 */
  send(chatId: string, message: TelegramMessage): Promise<TelegramResult>;
  /** bot 的 username（不含 @），組訂閱連結用；查不到時回傳 null */
  getUsername(): Promise<string | null>;
  /** 讓 Telegram 把使用者傳給 bot 的訊息送到這個網址（訂閱用），並帶上驗證用的 secret */
  setWebhook(url: string, secret: string): Promise<TelegramResult>;
  getWebhookInfo(): Promise<TelegramWebhookInfo | null>;
}

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;
/** webhook 只需要這兩種：使用者傳的訊息（/start、/stop）與封鎖／解除封鎖 bot */
export const WEBHOOK_UPDATES = ['message', 'my_chat_member'];

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

const replyMarkup = (link: TelegramLink | undefined) => (link ? { reply_markup: { inline_keyboard: [[{ text: link.label, url: link.url }]] } } : {});

/** bot 的 username 幾乎不會變，同一個伺服器實例快取 1 天 */
const USERNAME_CACHE_MS = 24 * 3600_000;
const usernameCache = new Map<string, { username: string; at: number }>();

export class HttpTelegramClient implements TelegramClient {
  readonly configured = true;

  constructor(
    private readonly token: string,
    readonly chatIds: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  send(chatId: string, message: TelegramMessage): Promise<TelegramResult> {
    // https://core.telegram.org/bots/api#sendphoto（說明文字放在圖片上方，跟 LINE 卡片一樣文字在上、圖在下）
    if (message.type === 'photo') {
      return this.post('sendPhoto', {
        chat_id: chatId,
        photo: message.photoUrl,
        caption: message.caption,
        parse_mode: 'HTML',
        show_caption_above_media: true,
        ...replyMarkup(message.link),
      });
    }
    // https://core.telegram.org/bots/api#sendmessage（訊息裡的連結不展開預覽）
    return this.post('sendMessage', {
      chat_id: chatId,
      text: message.html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...replyMarkup(message.link),
    });
  }

  async getUsername(): Promise<string | null> {
    const cached = usernameCache.get(this.token);
    if (cached && this.now() - cached.at < USERNAME_CACHE_MS) return cached.username;
    // https://core.telegram.org/bots/api#getme
    const me = await this.get<{ username?: string }>('getMe');
    if (!me?.username) return cached?.username ?? null;
    usernameCache.set(this.token, { username: me.username, at: this.now() });
    return me.username;
  }

  setWebhook(url: string, secret: string): Promise<TelegramResult> {
    // https://core.telegram.org/bots/api#setwebhook
    return this.post('setWebhook', { url, secret_token: secret, allowed_updates: WEBHOOK_UPDATES });
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo | null> {
    // https://core.telegram.org/bots/api#getwebhookinfo
    const info = await this.get<{ url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string }>('getWebhookInfo');
    if (!info) return null;
    return {
      url: info.url ?? '',
      pendingUpdateCount: info.pending_update_count ?? 0,
      lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000) : null,
      lastErrorMessage: info.last_error_message ?? null,
    };
  }

  /** 查詢類的方法：失敗時回傳 null（只用在畫面顯示，查不到不影響推播） */
  private async get<T>(method: 'getMe' | 'getWebhookInfo'): Promise<T | null> {
    try {
      const res = await this.fetchImpl(`${API}/bot${this.token}/${method}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
      if (!res.ok) return null;
      const body = (await res.json()) as { ok?: boolean; result?: T };
      return body.ok ? (body.result ?? null) : null;
    } catch {
      return null;
    }
  }

  private async post(method: 'sendMessage' | 'sendPhoto' | 'setWebhook', body: unknown): Promise<TelegramResult> {
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
  async getUsername(): Promise<string | null> {
    return null;
  }
  async setWebhook(): Promise<TelegramResult> {
    return { ok: false, status: null, retryable: false, error: 'Telegram 尚未設定' };
  }
  async getWebhookInfo(): Promise<TelegramWebhookInfo | null> {
    return null;
  }
}
