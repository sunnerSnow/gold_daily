import { checkEnv, getEnv } from '@/lib/env';
import { buildDeps } from '@/lib/server';
import { handleTelegramUpdate, verifyTelegramWebhookSecret } from '@/lib/telegram/webhook';

// Telegram webhook：私訊 bot 傳 /start 訂閱、/stop 取消（見 lib/telegram/webhook.ts）。
// 不走登入（Telegram 的伺服器呼叫），改用設定 webhook 時給的 secret 驗證；沒設定 Telegram 時一律拒絕。

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request) {
  const env = getEnv();
  if (!checkEnv(env).telegram) return new Response('Telegram not configured', { status: 503 });
  if (!verifyTelegramWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_BOT_TOKEN!)) {
    return new Response('Invalid secret', { status: 401 });
  }
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  // 資料庫出錯時回 500，Telegram 會自己重送這則 update
  await handleTelegramUpdate(await buildDeps(), update);
  return Response.json({ ok: true });
}
