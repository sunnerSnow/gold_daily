import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEnv, readEnv } from '../env';
import { isAuthorizedCronRequest } from './cron';
import { authMode, createSessionToken, verifySessionToken } from './session';

const SECRET = 'cron-secret-for-tests-0123456789';

describe('排程 API 授權', () => {
  const req = (auth?: string) => new Request('https://example.test/api/cron/daily', { headers: auth ? { authorization: auth } : {} });

  it('正確的 Bearer 才能通過', () => {
    expect(isAuthorizedCronRequest(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it.each([
    ['沒有 Authorization', undefined],
    ['秘密錯誤', 'Bearer wrong-secret-0123456789abc'],
    ['不是 Bearer', `Basic ${SECRET}`],
    ['只差一個字', `Bearer ${SECRET.slice(0, -1)}x`],
  ])('%s → 拒絕', (_l, auth) => {
    expect(isAuthorizedCronRequest(req(auth), SECRET)).toBe(false);
  });

  it('伺服器沒設定 CRON_SECRET 時一律拒絕', () => {
    expect(isAuthorizedCronRequest(req('Bearer '), undefined)).toBe(false);
    expect(isAuthorizedCronRequest(req('Bearer short'), 'short')).toBe(false);
  });
});

describe('排程 API 路由', () => {
  afterEach(() => vi.unstubAllEnvs());
  // 就算開發者的環境有真的金鑰，測試也絕不連到真的 LINE 或 Supabase
  beforeEach(() => {
    for (const key of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) vi.stubEnv(key, '');
  });

  it('未授權的請求回 401，且不執行排程', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('GOLD_PRICE_PROVIDER', 'mock');
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/daily/route');
    const res = await GET(new Request('https://example.test/api/cron/daily'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const { getStore } = await import('../store');
    expect(await getStore().listJobRuns({ limit: 10 })).toHaveLength(0);
  });

  it('授權的請求會執行排程並回傳結果', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('GOLD_PRICE_PROVIDER', 'mock');
    vi.resetModules();
    const { POST } = await import('@/app/api/cron/intraday/route');
    const res = await POST(new Request('https://example.test/api/cron/intraday', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }));
    expect([200, 500]).toContain(res.status);
    expect(await res.json()).toHaveProperty('status');
  });
});

describe('環境變數檢查', () => {
  it('缺少 LINE 設定時明確列出，且 LINE 視為未連線', () => {
    const s = checkEnv(readEnv({ GOLD_PRICE_PROVIDER: 'mock' }));
    expect(s.line).toBe(false);
    expect(s.issues.map((i) => i.key)).toEqual(expect.arrayContaining(['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID', 'CRON_SECRET']));
  });

  it('LINE_USER_ID 格式錯誤也算未連線', () => {
    const s = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_USER_ID: 'not-a-user-id' }));
    expect(s.line).toBe(false);
    expect(s.issues.some((i) => i.message.includes('格式不正確'))).toBe(true);
  });

  it('Supabase 只設一半時提示設定不完整', () => {
    const s = checkEnv(readEnv({ SUPABASE_URL: 'https://x.supabase.co' }));
    expect(s.supabase).toBe(false);
    expect(s.issues.some((i) => i.key === 'SUPABASE_SERVICE_ROLE_KEY')).toBe(true);
  });

  it('完整設定時沒有對應的問題', () => {
    const s = checkEnv(
      readEnv({
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        LINE_CHANNEL_ACCESS_TOKEN: 'token',
        LINE_USER_ID: `U${'a'.repeat(32)}`,
        CRON_SECRET: SECRET,
        ADMIN_PASSWORD: 'pw',
        SESSION_SECRET: 's'.repeat(32),
        GOLD_PRICE_PROVIDER: 'mock',
      }),
    );
    expect(s).toMatchObject({ supabase: true, line: true, cron: true, admin: true });
    expect(s.issues).toHaveLength(0);
  });

  it('使用 GoldAPI 但沒有金鑰時提示', () => {
    const s = checkEnv(readEnv({ GOLD_PRICE_PROVIDER: 'goldapi' }));
    expect(s.issues.some((i) => i.key === 'GOLD_PRICE_API_KEY')).toBe(true);
  });

  it('檢查結果不包含秘密的值', () => {
    const s = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'super-secret-token', CRON_SECRET: 'short' }));
    expect(JSON.stringify(s)).not.toContain('super-secret-token');
  });
});

describe('管理介面登入憑證', () => {
  const secret = 's'.repeat(40);
  const now = new Date('2026-10-13T02:00:00Z');

  it('簽發的憑證可以驗證，竄改或過期則失敗', async () => {
    const token = await createSessionToken(secret, now);
    expect(await verifySessionToken(token, secret, now)).toBe(true);
    expect(await verifySessionToken(`${token}x`, secret, now)).toBe(false);
    expect(await verifySessionToken(token, 't'.repeat(40), now)).toBe(false);
    expect(await verifySessionToken(token, secret, new Date('2026-12-31T00:00:00Z'))).toBe(false);
  });

  it('正式環境沒設定密碼時鎖住管理介面', () => {
    expect(authMode({ NODE_ENV: 'production' })).toBe('locked');
    expect(authMode({ NODE_ENV: 'development' })).toBe('open-dev');
    expect(authMode({ ADMIN_PASSWORD: 'pw', SESSION_SECRET: 's'.repeat(32) })).toBe('login');
  });
});
