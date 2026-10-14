import 'server-only';
import { checkEnv, getEnv } from '../env';
import { MemoryStore } from './memory';
import { SupabaseStore } from './supabase';
import type { Store } from './types';

// 有 Supabase 設定就用 Supabase；沒有就用記憶體（只限本機開發，畫面會提示資料不會保留）。
// 記憶體版掛在 globalThis，避免 next dev 熱更新時被清空。

const globalForStore = globalThis as unknown as { __goldDailyMemoryStore?: MemoryStore };

export function getStore(): Store {
  const env = getEnv();
  if (checkEnv(env).supabase) {
    return new SupabaseStore(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
  }
  if (!globalForStore.__goldDailyMemoryStore) globalForStore.__goldDailyMemoryStore = new MemoryStore();
  return globalForStore.__goldDailyMemoryStore;
}

export type { Store } from './types';
