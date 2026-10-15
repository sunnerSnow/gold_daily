import 'server-only';
import { authMode, type AuthMode } from '../auth/session';
import { checkEnv, getEnv } from '../env';
import { assessQuote } from '../freshness';
import type { ProviderStatus } from '../gold/types';
import type { JobDeps } from '../jobs/deps';

// 每一頁頁首、提示橫幅需要的狀態。只回傳「有沒有設定」，不回傳任何秘密。

export type FeedState = 'unconfigured' | 'empty' | 'fresh' | 'stale';

export interface Chrome {
  provider: ProviderStatus;
  feed: FeedState;
  lineConfigured: boolean;
  storeKind: 'supabase' | 'memory';
  auth: AuthMode;
}

export async function loadChrome(deps: JobDeps): Promise<Chrome> {
  const env = getEnv();
  const status = checkEnv(env);
  const provider = deps.provider.getProviderStatus();
  let feed: FeedState = 'unconfigured';
  if (provider.configured && provider.instrument) {
    const [latest, settings] = await Promise.all([
      deps.store.getLatestSnapshot({ source: deps.provider.id, symbol: provider.instrument.symbol }),
      deps.store.getSettings(),
    ]);
    // 依查價時間表判斷，兩次查價之間不算過期（見 lib/freshness.ts）
    feed = !latest ? 'empty' : assessQuote(latest, settings, deps.now(), provider.staleAfterMinutes).state === 'current' ? 'fresh' : 'stale';
  }
  return {
    provider,
    feed,
    lineConfigured: status.line,
    storeKind: deps.store.kind,
    auth: authMode(env),
  };
}

export function feedLabel(c: Chrome): string {
  if (c.feed === 'unconfigured') return '行情 未設定';
  const name = c.provider.isMock ? 'Mock' : c.provider.name;
  return `行情 ${name}・${{ empty: '尚無資料', fresh: '有效', stale: '過期' }[c.feed]}`;
}
