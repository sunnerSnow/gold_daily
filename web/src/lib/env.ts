import { z } from 'zod';

// 伺服器端環境變數。秘密只在這裡讀取，永遠不回傳到前端或 API 回應；
// 給畫面用的只有「有沒有設定、哪裡不完整」。

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Supabase 後台的 Data API 頁面會顯示 https://xxx.supabase.co/rest/v1/，SDK 只要網域，這裡統一去掉路徑 */
const supabaseUrl = optionalText.transform((v) => {
  if (!v) return v;
  try {
    return new URL(v).origin;
  } catch {
    return v;
  }
});

const schema = z.object({
  NEXT_PUBLIC_APP_URL: optionalText,
  /** Vercel 自動提供的正式網域（不含 https://），沒設 NEXT_PUBLIC_APP_URL 時用來組走勢圖網址 */
  VERCEL_PROJECT_PRODUCTION_URL: optionalText,
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: optionalText,
  SUPABASE_SERVICE_ROLE_KEY: optionalText,
  LINE_CHANNEL_ACCESS_TOKEN: optionalText,
  /** 推播名單：一個或多個 LINE User ID，用逗號分隔 */
  LINE_USER_ID: optionalText,
  /** 只有 webhook（好友傳「ID」取得自己的 User ID）需要，用來驗證請求真的來自 LINE */
  LINE_CHANNEL_SECRET: optionalText,
  GOLD_PRICE_PROVIDER: optionalText,
  GOLD_PRICE_API_KEY: optionalText,
  CRON_SECRET: optionalText,
  GOLD_SYMBOL: optionalText,
  GOLD_CURRENCY: optionalText,
  GOLD_UNIT: optionalText,
  ADMIN_PASSWORD: optionalText,
  MOCK_MONTHLY_QUOTA: optionalText,
  SESSION_SECRET: optionalText,
  NODE_ENV: optionalText,
});

export type AppEnv = z.infer<typeof schema>;

export interface EnvIssue {
  key: string;
  message: string;
}

export interface EnvStatus {
  supabase: boolean;
  line: boolean;
  cron: boolean;
  admin: boolean;
  provider: string | undefined;
  isProduction: boolean;
  issues: EnvIssue[];
}

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

/** LINE_USER_ID 可以填多個，用逗號（或空白）分隔；重複的只算一次 */
export function parseLineUserIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,，]+/).filter(Boolean))];
}

export function isLineUserId(value: string): boolean {
  return LINE_USER_ID_PATTERN.test(value);
}

export function readEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  return schema.parse(source);
}

export function checkEnv(env: AppEnv): EnvStatus {
  const issues: EnvIssue[] = [];

  const hasUrl = Boolean(env.SUPABASE_URL);
  const hasServiceKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
  let supabase = hasUrl && hasServiceKey;
  if (hasUrl !== hasServiceKey) {
    issues.push({
      key: hasUrl ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_URL',
      message: 'Supabase 設定不完整，需同時設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。',
    });
  }
  if (hasUrl && !/^https?:\/\//.test(env.SUPABASE_URL!)) {
    issues.push({ key: 'SUPABASE_URL', message: 'SUPABASE_URL 格式不正確。' });
    supabase = false;
  }

  const hasToken = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  const userIds = parseLineUserIds(env.LINE_USER_ID);
  const hasUser = userIds.length > 0;
  let line = hasToken && hasUser;
  if (!hasToken) issues.push({ key: 'LINE_CHANNEL_ACCESS_TOKEN', message: '缺少 LINE_CHANNEL_ACCESS_TOKEN，LINE 尚未連線。' });
  if (!hasUser) issues.push({ key: 'LINE_USER_ID', message: '缺少 LINE_USER_ID，LINE 尚未連線。' });
  const badIds = userIds.map((id, i) => (isLineUserId(id) ? 0 : i + 1)).filter(Boolean);
  if (badIds.length) {
    const which = userIds.length > 1 ? `第 ${badIds.join('、')} 個` : '';
    issues.push({ key: 'LINE_USER_ID', message: `LINE_USER_ID ${which}格式不正確（應為 U 開頭加 32 個十六進位字元，多個用逗號分隔）。` });
    line = false;
  }

  let cron = Boolean(env.CRON_SECRET);
  if (!cron) issues.push({ key: 'CRON_SECRET', message: '缺少 CRON_SECRET，排程 API 會拒絕所有請求。' });
  else if (env.CRON_SECRET!.length < 16) {
    issues.push({ key: 'CRON_SECRET', message: 'CRON_SECRET 太短，請至少 16 個字元。' });
    cron = false;
  }

  let admin = Boolean(env.ADMIN_PASSWORD && env.SESSION_SECRET);
  if (!env.ADMIN_PASSWORD) issues.push({ key: 'ADMIN_PASSWORD', message: '缺少 ADMIN_PASSWORD，管理介面沒有登入保護。' });
  if (!env.SESSION_SECRET) issues.push({ key: 'SESSION_SECRET', message: '缺少 SESSION_SECRET，無法簽發登入憑證。' });
  else if (env.SESSION_SECRET.length < 32) {
    issues.push({ key: 'SESSION_SECRET', message: 'SESSION_SECRET 太短，請至少 32 個字元。' });
    admin = false;
  }

  if (!env.GOLD_PRICE_PROVIDER) {
    issues.push({ key: 'GOLD_PRICE_PROVIDER', message: '尚未設定行情來源；正式使用設為 goldapi，開發時可設為 mock。' });
  } else if (env.GOLD_PRICE_PROVIDER.toLowerCase() === 'goldapi' && !env.GOLD_PRICE_API_KEY) {
    issues.push({ key: 'GOLD_PRICE_API_KEY', message: '使用 GoldAPI 需要設定 GOLD_PRICE_API_KEY。' });
  } else if (env.GOLD_PRICE_PROVIDER.toLowerCase() === 'mock' && env.NODE_ENV === 'production') {
    issues.push({ key: 'GOLD_PRICE_PROVIDER', message: '正式環境目前使用 Mock Provider（模擬資料）。' });
  }

  // 走勢圖要用公開的 https 網址；判斷不出來時每日推播照常送文字，只是不附圖
  if (env.NEXT_PUBLIC_APP_URL && !env.NEXT_PUBLIC_APP_URL.startsWith('https://')) {
    if (env.NODE_ENV === 'production') {
      issues.push({ key: 'NEXT_PUBLIC_APP_URL', message: 'NEXT_PUBLIC_APP_URL 不是 https，LINE 不接受，每日推播不會附走勢圖。' });
    }
  } else if (!env.NEXT_PUBLIC_APP_URL && !env.VERCEL_PROJECT_PRODUCTION_URL && env.NODE_ENV === 'production') {
    issues.push({ key: 'NEXT_PUBLIC_APP_URL', message: '無法判斷網站網址，每日推播不會附走勢圖；請設定 NEXT_PUBLIC_APP_URL。' });
  }

  return {
    supabase,
    line,
    cron,
    admin,
    provider: env.GOLD_PRICE_PROVIDER,
    isProduction: env.NODE_ENV === 'production',
    issues,
  };
}

let cached: AppEnv | null = null;

/** 伺服器端讀取一次後快取（測試可以傳入自己的 env） */
export function getEnv(): AppEnv {
  if (!cached) cached = readEnv();
  return cached;
}
