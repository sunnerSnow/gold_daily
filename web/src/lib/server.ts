import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { authMode, SESSION_COOKIE, verifySessionToken } from './auth/session';
import { checkEnv, getEnv } from './env';
import { createProvider } from './gold/registry';
import type { JobDeps } from './jobs/deps';
import { HttpLineClient, UnconfiguredLineClient } from './line/client';
import { getStore } from './store';

// 伺服器端組裝依賴：Route Handler、Server Action、頁面都從這裡拿。

export async function buildDeps(): Promise<JobDeps> {
  const env = getEnv();
  const status = checkEnv(env);
  const store = getStore();
  const settings = await store.getSettings();
  return {
    store,
    provider: createProvider({
      providerId: env.GOLD_PRICE_PROVIDER,
      apiKey: env.GOLD_PRICE_API_KEY,
      symbol: env.GOLD_SYMBOL,
      currency: env.GOLD_CURRENCY,
      unit: env.GOLD_UNIT,
      mockScenario: settings.mockScenario,
      mockMonthlyQuota: env.MOCK_MONTHLY_QUOTA ? Number(env.MOCK_MONTHLY_QUOTA) || null : null,
    }),
    line: status.line ? new HttpLineClient(env.LINE_CHANNEL_ACCESS_TOKEN!, env.LINE_USER_ID!) : new UnconfiguredLineClient(),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () => randomUUID(),
  };
}

/** 目前的請求是否有管理權限（Server Action 一定要再檢查一次，不能只靠 proxy） */
export async function isAdmin(): Promise<boolean> {
  const env = getEnv();
  const mode = authMode(env);
  if (mode === 'open-dev') return true;
  if (mode === 'locked') return false;
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value, env.SESSION_SECRET, new Date());
}

export class UnauthorizedError extends Error {
  constructor() {
    super('沒有權限，請重新登入');
    this.name = 'UnauthorizedError';
  }
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new UnauthorizedError();
}
