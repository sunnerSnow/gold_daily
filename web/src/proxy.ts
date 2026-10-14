import { NextResponse, type NextRequest } from 'next/server';
import { authMode, SESSION_COOKIE, verifySessionToken } from './lib/auth/session';

// 管理介面登入檢查（樂觀檢查；Server Action 內還會再驗一次）。
// 排程 API 不經過這裡，它們用 CRON_SECRET 自己驗證。

export async function proxy(request: NextRequest) {
  const mode = authMode({
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  });
  if (mode === 'open-dev') return NextResponse.next();

  const ok =
    mode === 'login' &&
    (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET, new Date()));
  if (ok) return NextResponse.next();

  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = '/login';
  url.search = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|api/cron|_next/static|_next/image|favicon.ico).*)'],
};
