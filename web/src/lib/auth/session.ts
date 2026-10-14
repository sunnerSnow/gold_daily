import { timingSafeEqual } from './cron';

// 管理介面的登入憑證：cookie 內容是「到期時間.HMAC 簽章」，用 SESSION_SECRET 簽。
// 只用 Web Crypto，proxy 與 server 都能用。

export const SESSION_COOKIE = 'gd_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Buffer.from(sig).toString('base64url');
}

export async function createSessionToken(secret: string, now: Date): Promise<string> {
  const expires = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expires}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySessionToken(token: string | undefined, secret: string | undefined, now: Date): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires * 1000 < now.getTime()) return false;
  const expected = await hmac(secret, `${parts[0]}.${parts[1]}`);
  return timingSafeEqual(parts[2], expected);
}

export function checkPassword(input: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return timingSafeEqual(input, expected);
}

/**
 * 管理介面是否需要登入：
 * - 有設定 ADMIN_PASSWORD 與 SESSION_SECRET → 需要登入
 * - 沒設定且是本機開發 → 不需要（畫面會提示未受保護）
 * - 沒設定但是正式環境 → 一律擋下（避免公開網址被任何人按測試推播）
 */
export type AuthMode = 'login' | 'open-dev' | 'locked';

export function authMode(env: { ADMIN_PASSWORD?: string; SESSION_SECRET?: string; NODE_ENV?: string }): AuthMode {
  if (env.ADMIN_PASSWORD && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return 'login';
  return env.NODE_ENV === 'production' ? 'locked' : 'open-dev';
}
