import { MockGoldPriceProvider, type MockScenario } from '../gold/mock-provider';
import type { LineClient, LineQuota, PushContent, PushResult } from '../line/client';
import { MemoryStore } from '../store/memory';
import type { JobDeps } from './deps';

// 測試用的假 LINE 與可控制的時鐘。測試絕不呼叫真的 LINE 或行情來源。

export class FakeLine implements LineClient {
  configured = true;
  pushes: { text: string; imageUrl: string | null; retryKey: string }[] = [];
  /** 依序回傳的結果；用完後一律成功 */
  script: PushResult[] = [];
  quota: LineQuota = { type: 'limited', value: 200 };
  baseUsage = 0;
  quotaFails = false;
  private delivered = new Set<string>();

  async push({ text, imageUrl }: PushContent, retryKey: string): Promise<PushResult> {
    this.pushes.push({ text, imageUrl: imageUrl ?? null, retryKey });
    const next = this.script.shift();
    if (next && !next.ok) return next;
    if (this.delivered.has(retryKey)) return { ok: true, duplicate: true };
    this.delivered.add(retryKey);
    return next ?? { ok: true, duplicate: false };
  }

  /** 實際送達（不重複計算）的則數 */
  get deliveredCount() {
    return this.delivered.size;
  }

  async getQuota() {
    if (this.quotaFails) throw new Error('LINE API 500');
    return this.quota;
  }

  async getConsumption() {
    if (this.quotaFails) throw new Error('LINE API 500');
    return { totalUsage: this.baseUsage + this.delivered.size };
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
  clock: Clock;
  deps(scenario?: MockScenario): JobDeps;
}

export function createWorld(startIso: string): TestWorld {
  const clock = new Clock(new Date(startIso));
  const store = new MemoryStore(clock.now);
  const line = new FakeLine();
  let id = 0;
  return {
    store,
    line,
    clock,
    deps(scenario: MockScenario = 'normal') {
      return {
        store,
        provider: new MockGoldPriceProvider({ scenario, now: clock.now }),
        line,
        now: clock.now,
        sleep: async () => {},
        newId: () => `00000000-0000-0000-0000-${String(++id).padStart(12, '0')}`,
      };
    },
  };
}
