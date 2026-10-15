import { getEnv } from '@/lib/env';
import { HttpLineClient } from '@/lib/line/client';
import { handleWebhookEvents, verifyLineSignature } from '@/lib/line/webhook';

// LINE webhook：好友傳「ID」時回覆對方自己的 User ID（見 lib/line/webhook.ts）。
// 不走登入（LINE 的伺服器呼叫），改用 LINE_CHANNEL_SECRET 驗證簽章；沒設定 secret 時一律拒絕。

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request) {
  const env = getEnv();
  if (!env.LINE_CHANNEL_SECRET) return new Response('Webhook not configured', { status: 503 });
  const body = await request.text();
  if (!verifyLineSignature(body, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  // 回覆只需要 access token，不需要推播名單
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    await handleWebhookEvents(new HttpLineClient(env.LINE_CHANNEL_ACCESS_TOKEN, []), payload);
  }
  // LINE 只看狀態碼；後台的「Verify」按鈕也會打這裡（events 是空陣列）
  return Response.json({ ok: true });
}
