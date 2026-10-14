// 排程 API 授權：Authorization: Bearer <CRON_SECRET>（Vercel Cron 會自動帶上）。
// 用固定時間比較，避免從回應時間猜出秘密。沒設定 CRON_SECRET 時一律拒絕。

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function isAuthorizedCronRequest(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(match[1], secret);
}

export { timingSafeEqual };
