import type { FlexMessage } from './flex';

// LINE Messaging API 用戶端。Token 只放在伺服器端，錯誤訊息與日誌都不帶 Token。

export type PushResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number | null; retryable: boolean; error: string };

export interface LineQuota {
  /** none = 沒有上限；limited = 有上限 */
  type: 'none' | 'limited';
  value: number | null;
}

/** 送出的訊息框：文字或卡片（Flex）。同一次請求最多 5 個訊息框，LINE 對每位收件人只算 1 則。 */
export type LineMessage = { type: 'text'; text: string } | FlexMessage;

export function textMessage(text: string): LineMessage {
  return { type: 'text', text: text.slice(0, LINE_TEXT_LIMIT) };
}

/** 推播對象：all＝官方帳號的所有好友（群發）；或指定的 LINE User ID 名單 */
export type LineRecipients = 'all' | string[];

export interface LineClient {
  readonly configured: boolean;
  /** 推播對象：所有好友或指定名單 */
  readonly target: 'all' | 'list';
  /** 推播對象人數（LINE 依人數計算額度）；群發時是 LINE 統計的好友數，未設定時為 0 */
  getRecipientCount(): Promise<number>;
  /** 送給所有推播對象。retryKey 重試時必須沿用同一個值，LINE 端才會去重 */
  push(messages: LineMessage[], retryKey: string): Promise<PushResult>;
  /** 回覆使用者剛傳來的訊息（webhook 用；回覆不算額度） */
  reply(replyToken: string, messages: LineMessage[]): Promise<PushResult>;
  getQuota(): Promise<LineQuota>;
  getConsumption(): Promise<{ totalUsage: number }>;
}

const API = 'https://api.line.me/v2/bot';
const TIMEOUT_MS = 10_000;
/** LINE 單則文字訊息上限 5000 字 */
export const LINE_TEXT_LIMIT = 5000;

export class LineApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'LineApiError';
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ? `LINE API ${res.status}：${body.message}` : `LINE API ${res.status}`;
  } catch {
    return `LINE API ${res.status}`;
  }
}

/** 群發時用 LINE 統計的好友數估算額度；統計一天更新一次，同一個伺服器實例快取 1 小時 */
const FOLLOWER_CACHE_MS = 3600_000;
const followerCache = new Map<string, { count: number; at: number }>();

/** 日本時間的日期 YYYYMMDD（LINE 統計 API 的日期以 UTC+9 計） */
function jstDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replaceAll('-', '');
}

export class HttpLineClient implements LineClient {
  readonly configured = true;

  constructor(
    private readonly token: string,
    /** all：群發給所有好友（broadcast）；名單：一人用 push，多人用 multicast 一次送出 */
    private readonly recipients: LineRecipients,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get target() {
    return this.recipients === 'all' ? ('all' as const) : ('list' as const);
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /**
   * 群發時查 LINE 的好友統計（可收到訊息的人數，已扣除封鎖）。統計要隔天才有，所以今天新加的好友會少算；
   * 實際用量仍以發送前同步的 LINE 官方用量為準。查不到時沿用上次的數字，從沒查到過就先算 1 人。
   * https://developers.line.biz/en/reference/messaging-api/#get-number-of-followers
   */
  async getRecipientCount(): Promise<number> {
    if (this.recipients !== 'all') return this.recipients.length;
    const cached = followerCache.get(this.token);
    const now = this.now();
    if (cached && now - cached.at < FOLLOWER_CACHE_MS) return cached.count;
    for (const daysAgo of [1, 2]) {
      try {
        const res = await this.fetchImpl(`${API}/insight/followers?date=${jstDate(now - daysAgo * 86_400_000)}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { status?: string; followers?: number; targetedReaches?: number; blocks?: number };
        if (body.status !== 'ready') continue;
        const reach = typeof body.targetedReaches === 'number' ? body.targetedReaches : (body.followers ?? 0) - (body.blocks ?? 0);
        const count = Math.max(1, reach);
        followerCache.set(this.token, { count, at: now });
        return count;
      } catch {
        // 統計查不到不影響推播，往下用備案
      }
    }
    return cached?.count ?? 1;
  }

  push(messages: LineMessage[], retryKey: string): Promise<PushResult> {
    // https://developers.line.biz/en/reference/messaging-api/#send-broadcast-message
    if (this.recipients === 'all') return this.send('broadcast', { messages }, retryKey);
    const multi = this.recipients.length > 1;
    // https://developers.line.biz/en/reference/messaging-api/#send-multicast-message
    return this.send(multi ? 'multicast' : 'push', { to: multi ? this.recipients : this.recipients[0], messages }, retryKey);
  }

  reply(replyToken: string, messages: LineMessage[]): Promise<PushResult> {
    return this.send('reply', { replyToken, messages }, null);
  }

  private async send(endpoint: 'push' | 'multicast' | 'broadcast' | 'reply', body: unknown, retryKey: string | null): Promise<PushResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/message/${endpoint}`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // 逾時不代表沒送到：重試時沿用同一個 retry key，LINE 會回 409 而不會重送
      return { ok: false, status: null, retryable: true, error: timedOut ? 'LINE API 逾時' : 'LINE API 連線失敗' };
    }
    if (res.ok) return { ok: true, duplicate: false };
    // 同一個 retry key 已被接受過（24 小時內）：視為已送出
    // https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
    if (res.status === 409 && res.headers.get('x-line-accepted-request-id')) return { ok: true, duplicate: true };
    const error = await readError(res);
    // 只有 5xx 才重試；429 也可能代表本月額度已用完，重試只會繼續失敗
    if (res.status === 429) return { ok: false, status: 429, retryable: false, error: `${error}（可能是本月訊息額度已用完）` };
    return { ok: false, status: res.status, retryable: res.status >= 500, error };
  }

  async getQuota(): Promise<LineQuota> {
    const res = await this.fetchImpl(`${API}/message/quota`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new LineApiError(await readError(res), res.status);
    const body = (await res.json()) as { type?: string; value?: number };
    if (body.type === 'none') return { type: 'none', value: null };
    if (body.type === 'limited' && typeof body.value === 'number') return { type: 'limited', value: body.value };
    throw new LineApiError('LINE 額度回應格式無法辨識', res.status);
  }

  async getConsumption(): Promise<{ totalUsage: number }> {
    const res = await this.fetchImpl(`${API}/message/quota/consumption`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new LineApiError(await readError(res), res.status);
    const body = (await res.json()) as { totalUsage?: number };
    if (typeof body.totalUsage !== 'number') throw new LineApiError('LINE 用量回應格式無法辨識', res.status);
    return { totalUsage: body.totalUsage };
  }
}

/** 沒設定 LINE 時使用：不會呼叫任何外部服務，也不會假裝送出 */
export class UnconfiguredLineClient implements LineClient {
  readonly configured = false;
  readonly target = 'list' as const;
  async getRecipientCount(): Promise<number> {
    return 0;
  }
  async push(): Promise<PushResult> {
    return { ok: false, status: null, retryable: false, error: 'LINE 尚未連線' };
  }
  async reply(): Promise<PushResult> {
    return { ok: false, status: null, retryable: false, error: 'LINE 尚未連線' };
  }
  async getQuota(): Promise<LineQuota> {
    throw new LineApiError('LINE 尚未連線', null);
  }
  async getConsumption(): Promise<{ totalUsage: number }> {
    throw new LineApiError('LINE 尚未連線', null);
  }
}
