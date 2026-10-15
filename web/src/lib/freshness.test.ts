import { describe, expect, it } from 'vitest';
import { assessQuote, lastScheduledCheck, nextScheduledCheck } from './freshness';
import { MemoryStore } from './store/memory';
import { DEFAULT_SETTINGS } from './store/types';

// 報價是否還是最新：依查價時間表判斷，兩次查價之間不算過期。
// 預設：交易日 09:00（每日推播）＋ 21:30（盤中），週末不查價。台北 = UTC+8。

const s = { ...DEFAULT_SETTINGS };
const at = (iso: string) => new Date(iso);
// 2026-10-15 是週四
const THU_0900 = '2026-10-15T01:00:02Z';

describe('最近一次預定查價', () => {
  it('兩次查價之間是上一次預定時間；過了預定時間 20 分鐘才算數', () => {
    expect(lastScheduledCheck(s, at('2026-10-15T02:26:00Z'))?.toISOString()).toBe('2026-10-15T01:00:00.000Z'); // 10:26 → 09:00
    expect(lastScheduledCheck(s, at('2026-10-15T13:40:00Z'))?.toISOString()).toBe('2026-10-15T01:00:00.000Z'); // 21:40 → 還在寬限內，仍是 09:00
    expect(lastScheduledCheck(s, at('2026-10-15T13:55:00Z'))?.toISOString()).toBe('2026-10-15T13:30:00.000Z'); // 21:55 → 21:30
  });

  it('凌晨與週末往前找到上一個交易日的最後一次', () => {
    expect(lastScheduledCheck(s, at('2026-10-15T23:00:00Z'))?.toISOString()).toBe('2026-10-15T13:30:00.000Z'); // 週五 07:00 → 週四 21:30
    expect(lastScheduledCheck(s, at('2026-10-18T04:00:00Z'))?.toISOString()).toBe('2026-10-16T13:30:00.000Z'); // 週日 → 週五 21:30
  });

  it('下次預定查價：每日推播與盤中檢查取較早的', () => {
    expect(nextScheduledCheck(s, at('2026-10-15T02:26:00Z'))?.toISOString()).toBe('2026-10-15T13:30:00.000Z'); // 10:26 → 21:30
    expect(nextScheduledCheck(s, at('2026-10-15T14:00:00Z'))?.toISOString()).toBe('2026-10-16T01:00:00.000Z'); // 22:00 → 明天 09:00
    expect(nextScheduledCheck(s, at('2026-10-16T14:00:00Z'))?.toISOString()).toBe('2026-10-19T01:00:00.000Z'); // 週五晚上 → 週一 09:00
  });

  it('不推播也不盤中檢查時沒有預定時間', () => {
    const none = { ...s, dailyEnabled: false, intradayMode: 'off' as const };
    expect(lastScheduledCheck(none, at('2026-10-15T02:26:00Z'))).toBeNull();
    expect(nextScheduledCheck(none, at('2026-10-15T02:26:00Z'))).toBeNull();
  });
});

describe('報價是否還是最新', () => {
  const quote = { quoteTimestamp: at(THU_0900), fetchedAt: at(THU_0900) };

  it('09:00 查到的報價，到 21:30 下次查價前都算最新（不是 30 分鐘就過期）', () => {
    for (const now of ['2026-10-15T02:26:00Z', '2026-10-15T09:00:00Z', '2026-10-15T13:45:00Z']) {
      expect(assessQuote(quote, s, at(now), 30), now).toEqual({ state: 'current' });
    }
  });

  it('21:30 該查沒查（過了寬限時間）→ 漏查', () => {
    expect(assessQuote(quote, s, at('2026-10-15T14:00:00Z'), 30)).toEqual({ state: 'missed', expectedAt: at('2026-10-15T13:30:00Z') });
  });

  it('週末沿用週五最後一次的報價是正常的', () => {
    const fri = { quoteTimestamp: at('2026-10-16T13:30:01Z'), fetchedAt: at('2026-10-16T13:30:01Z') };
    expect(assessQuote(fri, s, at('2026-10-18T04:00:00Z'), 30)).toEqual({ state: 'current' });
  });

  it('查價當下來源就沒更新（報價時間比取得時間早超過 30 分鐘）→ 來源過期', () => {
    const old = { quoteTimestamp: at('2026-10-14T23:00:00Z'), fetchedAt: at(THU_0900) };
    expect(assessQuote(old, s, at('2026-10-15T02:00:00Z'), 30)).toEqual({ state: 'source_stale' });
  });

  it('沿用 10 分鐘內查過的報價（比預定時間早一點取得）仍算準時', () => {
    const early = { quoteTimestamp: at('2026-10-15T00:52:00Z'), fetchedAt: at('2026-10-15T00:52:00Z') };
    expect(assessQuote(early, s, at('2026-10-15T02:00:00Z'), 30)).toEqual({ state: 'current' });
  });

  it('固定間隔模式：超過一個間隔加寬限沒有新報價才算漏查', () => {
    const every15 = { ...s, intradayMode: 'interval' as const, pollingIntervalMinutes: 15 as const };
    const q = { quoteTimestamp: at('2026-10-15T02:00:00Z'), fetchedAt: at('2026-10-15T02:00:00Z') };
    expect(assessQuote(q, every15, at('2026-10-15T02:40:00Z'), 30).state).toBe('current');
    expect(assessQuote(q, every15, at('2026-10-15T03:10:00Z'), 30).state).toBe('missed');
  });
});

describe('排程呼叫紀錄', () => {
  it('每次呼叫都更新時間，不影響鎖', async () => {
    const store = new MemoryStore(() => at('2026-10-15T02:00:00Z'));
    await store.recordCronCall('daily', at('2026-10-15T02:00:00Z'));
    expect((await store.getLocks()).find((l) => l.jobType === 'daily')?.lastCalledAt?.toISOString()).toBe('2026-10-15T02:00:00.000Z');
    // 只記錄呼叫的那一列不算上鎖，排程仍可以取得鎖
    expect(await store.tryAcquireLock('daily', 'owner-1', 60)).toBe(true);
    await store.recordCronCall('daily', at('2026-10-15T02:15:00Z'));
    const lock = (await store.getLocks()).find((l) => l.jobType === 'daily')!;
    expect(lock.lastCalledAt?.toISOString()).toBe('2026-10-15T02:15:00.000Z');
    expect(lock.owner).toBe('owner-1');
  });
});
