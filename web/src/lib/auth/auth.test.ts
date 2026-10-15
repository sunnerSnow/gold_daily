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

describe('LINE webhook 路由', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    // 不給 access token：就算簽章正確也不會呼叫真的 LINE 回覆
    for (const key of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) vi.stubEnv(key, '');
  });
  const post = async (body: string, signature?: string) => {
    vi.resetModules();
    const { POST } = await import('@/app/api/line/webhook/route');
    return POST(new Request('https://example.test/api/line/webhook', { method: 'POST', body, headers: signature ? { 'x-line-signature': signature } : {} }));
  };

  it('沒設定 LINE_CHANNEL_SECRET 時一律拒絕', async () => {
    vi.stubEnv('LINE_CHANNEL_SECRET', '');
    expect((await post('{"events":[]}')).status).toBe(503);
  });

  it('簽章錯誤回 401；簽章正確回 200（後台的 Verify 也是這樣）', async () => {
    const secret = 'channel-secret-for-route-test';
    vi.stubEnv('LINE_CHANNEL_SECRET', secret);
    const body = JSON.stringify({ destination: 'x', events: [] });
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('base64');
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A'))).status).toBe(401);
    expect((await post(body, sig)).status).toBe(200);
  });
});

describe('環境變數檢查', () => {
  it('LINE_USER_ID 可以填多個（逗號分隔），重複的只算一次', async () => {
    const { parseLineUserIds } = await import('../env');
    const a = `U${'a'.repeat(32)}`;
    const b = `U${'b'.repeat(32)}`;
    expect(parseLineUserIds(`${a}, ${b},${a}`)).toEqual([a, b]);
    expect(parseLineUserIds(`${a}，${b}`)).toEqual([a, b]);
    expect(parseLineUserIds(undefined)).toEqual([]);
    const ok = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_TARGET: 'list', LINE_USER_ID: `${a},${b}` }));
    expect(ok).toMatchObject({ line: true, lineTarget: 'list' });
    const bad = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_TARGET: 'list', LINE_USER_ID: `${a},U123` }));
    expect(bad.line).toBe(false);
    expect(bad.issues.find((i) => i.key === 'LINE_USER_ID')?.message).toContain('第 2 個');
    expect(JSON.stringify(bad)).not.toContain(a);
  });

  it('預設群發給所有好友：只要有 token，不需要 LINE_USER_ID', () => {
    const s = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token' }));
    expect(s).toMatchObject({ line: true, lineTarget: 'all' });
    expect(s.issues.some((i) => i.key === 'LINE_USER_ID')).toBe(false);
    // 群發時名單用不到，格式錯只提示、不影響連線
    const odd = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_USER_ID: 'not-a-user-id' }));
    expect(odd.line).toBe(true);
    expect(odd.issues.some((i) => i.key === 'LINE_USER_ID')).toBe(true);
    // 拼錯的 LINE_TARGET 會提示，並照預設群發
    const typo = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_TARGET: 'everyone' }));
    expect(typo).toMatchObject({ line: true, lineTarget: 'all' });
    expect(typo.issues.some((i) => i.key === 'LINE_TARGET')).toBe(true);
  });

  it('缺少 LINE 設定時明確列出，且 LINE 視為未連線', () => {
    const s = checkEnv(readEnv({ GOLD_PRICE_PROVIDER: 'mock' }));
    expect(s.line).toBe(false);
    expect(s.issues.map((i) => i.key)).toEqual(expect.arrayContaining(['LINE_CHANNEL_ACCESS_TOKEN', 'CRON_SECRET']));
    const list = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_TARGET: 'list' }));
    expect(list.line).toBe(false);
    expect(list.issues.some((i) => i.key === 'LINE_USER_ID')).toBe(true);
  });

  it('名單模式下 LINE_USER_ID 格式錯誤算未連線', () => {
    const s = checkEnv(readEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'token', LINE_TARGET: 'list', LINE_USER_ID: 'not-a-user-id' }));
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

  it('SUPABASE_URL 多貼了 /rest/v1/ 也能用', () => {
    expect(readEnv({ SUPABASE_URL: 'https://abc.supabase.co/rest/v1/' }).SUPABASE_URL).toBe('https://abc.supabase.co');
    expect(readEnv({ SUPABASE_URL: ' https://abc.supabase.co ' }).SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('正式環境判斷不出網站網址或不是 https 時，提示走勢圖不會附上', () => {
    const urlIssue = (env: Record<string, string>) => checkEnv(readEnv({ NODE_ENV: 'production', ...env })).issues.find((i) => i.key === 'NEXT_PUBLIC_APP_URL');
    expect(urlIssue({})?.message).toContain('不會附走勢圖');
    expect(urlIssue({ NEXT_PUBLIC_APP_URL: 'http://gold.example' })?.message).toContain('不是 https');
    // Vercel 會自動提供正式網域，不用另外設定
    expect(urlIssue({ VERCEL_PROJECT_PRODUCTION_URL: 'gold-daily-pearl.vercel.app' })).toBeUndefined();
    expect(urlIssue({ NEXT_PUBLIC_APP_URL: 'https://gold.example' })).toBeUndefined();
    // 本機開發不提示
    expect(checkEnv(readEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })).issues.some((i) => i.key === 'NEXT_PUBLIC_APP_URL')).toBe(false);
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
