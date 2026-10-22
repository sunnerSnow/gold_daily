import { MockGoldPriceProvider, type MockScenario } from '../gold/mock-provider';
import type { LineClient, LineMessage, LineQuota, PushResult } from '../line/client';
import type { FlexMessage } from '../line/flex';
import { MemoryStore } from '../store/memory';
import type { TelegramClient, TelegramMessage, TelegramResult, TelegramWebhookInfo } from '../telegram/client';
import type { JobDeps } from './deps';

// 測試用的假 LINE、假 Telegram 與可控制的時鐘。測試絕不呼叫真的 LINE、Telegram 或行情來源。

export interface FakePush {
  messages: LineMessage[];
  /** 所有文字訊息框接起來（沒有文字時是空字串） */
  text: string;
  /** 卡片（Flex）；沒有時為 null */
  card: FlexMessage | null;
  retryKey: string;
}

export class FakeLine implements LineClient {
  configured = true;
  target: 'all' | 'list' = 'list';
  /** 推播對象人數（測試可調整，模擬多人或群發） */
  recipientCount = 1;
  async getRecipientCount() {
    return this.recipientCount;
  }
  pushes: FakePush[] = [];
  replies: { replyToken: string; messages: LineMessage[] }[] = [];
  /** 依序回傳的結果；用完後一律成功 */
  script: PushResult[] = [];
  /** 模擬 LINE 拒絕卡片（回 400） */
  rejectCards = false;
  quota: LineQuota = { type: 'limited', value: 200 };
  baseUsage = 0;
  quotaFails = false;
  private delivered = new Set<string>();

  async push(messages: LineMessage[], retryKey: string): Promise<PushResult> {
    const text = messages.flatMap((m) => (m.type === 'text' ? [m.text] : [])).join('\n');
    const card = (messages.find((m) => m.type === 'flex') as FlexMessage | undefined) ?? null;
    this.pushes.push({ messages, text, card, retryKey });
    if (this.rejectCards && card) return { ok: false, status: 400, retryable: false, error: 'LINE API 400：A message (messages[0]) in the request body is invalid' };
    const next = this.script.shift();
    if (next && !next.ok) return next;
    if (this.delivered.has(retryKey)) return { ok: true, duplicate: true };
    this.delivered.add(retryKey);
    return next ?? { ok: true, duplicate: false };
  }

  async reply(replyToken: string, messages: LineMessage[]): Promise<PushResult> {
    this.replies.push({ replyToken, messages });
    return { ok: true, duplicate: false };
  }

  /** 實際送達（不重複計算）的次數；每次送給 recipientCount 人 */
  get deliveredCount() {
    return this.delivered.size;
  }

  async getQuota() {
    if (this.quotaFails) throw new Error('LINE API 500');
    return this.quota;
  }

  async getConsumption() {
    if (this.quotaFails) throw new Error('LINE API 500');
    // LINE 依收件人數計算：每次送出用掉 recipientCount 則
    return { totalUsage: this.baseUsage + this.delivered.size * this.recipientCount };
  }
}

export class FakeTelegram implements TelegramClient {
  /** 預設沒設定（既有測試只看 LINE）；測 Telegram 時設成 true */
  configured = false;
  chatIds: string[] = ['1001'];
  /** 每一次呼叫（含失敗的）與結果 */
  sends: { chatId: string; message: TelegramMessage; ok: boolean }[] = [];
  /** 依序回傳的結果；用完後一律成功 */
  script: TelegramResult[] = [];
  /** 某些聊天室一律失敗（例如封鎖了 bot） */
  failingChats = new Map<string, TelegramResult>();
  /** 模擬 Telegram 抓不到走勢圖（回 400） */
  rejectPhotos = false;

  async send(chatId: string, message: TelegramMessage): Promise<TelegramResult> {
    const result = this.respond(chatId, message);
    this.sends.push({ chatId, message, ok: result.ok });
    return result;
  }

  private respond(chatId: string, message: TelegramMessage): TelegramResult {
    if (this.rejectPhotos && message.type === 'photo') {
      return { ok: false, status: 400, retryable: false, error: 'Telegram API 400：Bad Request: failed to get HTTP URL content' };
    }
    return this.failingChats.get(chatId) ?? this.script.shift() ?? { ok: true };
  }

  /** 某個聊天室實際收到的訊息（不含失敗的） */
  received(chatId: string): TelegramMessage[] {
    return this.sends.filter((s) => s.chatId === chatId && s.ok).map((s) => s.message);
  }

  username = 'gold_daily_test_bot';
  webhook: { url: string; secret: string } | null = null;

  async getUsername() {
    return this.username;
  }

  async setWebhook(url: string, secret: string): Promise<TelegramResult> {
    this.webhook = { url, secret };
    return { ok: true };
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo | null> {
    return { url: this.webhook?.url ?? '', pendingUpdateCount: 0, lastErrorAt: null, lastErrorMessage: null };
  }
}

export class Clock {
  constructor(public current: Date) {}
  now = () => new Date(this.current);
  set(iso: string) {
    this.current = new Date(iso);
  }
  advanceMinutes(m: number) {
    this.current = new Date(this.current.getTime() + m * 60_000);
  }
}

/** 有每月次數上限的假來源（行為跟 Mock 一樣，但會計次，用來測查價次數保護） */
export class LimitedMockProvider extends MockGoldPriceProvider {
  latestCalls = 0;
  historyCalls = 0;
  constructor(
    options: ConstructorParameters<typeof MockGoldPriceProvider>[0],
    private readonly quota = 100,
  ) {
    super(options);
  }
  override async getLatestPrice() {
    this.latestCalls += 1;
    return super.getLatestPrice();
  }
  override async getHistoricalPrice(range: Parameters<MockGoldPriceProvider['getHistoricalPrice']>[0]) {
    this.historyCalls += 1;
    return super.getHistoricalPrice(range);
  }
  override getProviderStatus() {
    return { ...super.getProviderStatus(), monthlyCallQuota: this.quota };
  }
}

export interface TestWorld {
  store: MemoryStore;
  line: FakeLine;
  telegram: FakeTelegram;
  clock: Clock;
  deps(scenario?: MockScenario): JobDeps;
}

export function createWorld(startIso: string): TestWorld {
  const clock = new Clock(new Date(startIso));
  const store = new MemoryStore(clock.now);
  const line = new FakeLine();
  const telegram = new FakeTelegram();
  let id = 0;
  return {
    store,
    line,
    telegram,
    clock,
    deps(scenario: MockScenario = 'normal') {
      return {
        store,
        provider: new MockGoldPriceProvider({ scenario, now: clock.now }),
        line,
        telegram,
        now: clock.now,
        sleep: async () => {},
        newId: () => `00000000-0000-0000-0000-${String(++id).padStart(12, '0')}`,
      };
    },
  };
}
