// LINE Messaging API 用戶端。Token 只放在伺服器端，錯誤訊息與日誌都不帶 Token。

export type PushResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number | null; retryable: boolean; error: string };

export interface LineQuota {
  /** none = 沒有上限；limited = 有上限 */
  type: 'none' | 'limited';
  value: number | null;
}

export interface LineClient {
  readonly configured: boolean;
  /** retryKey 重試時必須沿用同一個值，LINE 端才會去重 */
  pushText(text: string, retryKey: string): Promise<PushResult>;
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

export class HttpLineClient implements LineClient {
  readonly configured = true;

  constructor(
    private readonly token: string,
    private readonly userId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async pushText(text: string, retryKey: string): Promise<PushResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/message/push`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey }),
        body: JSON.stringify({ to: this.userId, messages: [{ type: 'text', text: text.slice(0, LINE_TEXT_LIMIT) }] }),
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
  async pushText(): Promise<PushResult> {
    return { ok: false, status: null, retryable: false, error: 'LINE 尚未連線' };
  }
  async getQuota(): Promise<LineQuota> {
    throw new LineApiError('LINE 尚未連線', null);
  }
  async getConsumption(): Promise<{ totalUsage: number }> {
    throw new LineApiError('LINE 尚未連線', null);
  }
}
