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
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: optionalText,
  SUPABASE_SERVICE_ROLE_KEY: optionalText,
  LINE_CHANNEL_ACCESS_TOKEN: optionalText,
  LINE_USER_ID: optionalText,
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
  const hasUser = Boolean(env.LINE_USER_ID);
  let line = hasToken && hasUser;
  if (!hasToken) issues.push({ key: 'LINE_CHANNEL_ACCESS_TOKEN', message: '缺少 LINE_CHANNEL_ACCESS_TOKEN，LINE 尚未連線。' });
  if (!hasUser) issues.push({ key: 'LINE_USER_ID', message: '缺少 LINE_USER_ID，LINE 尚未連線。' });
  if (hasUser && !LINE_USER_ID_PATTERN.test(env.LINE_USER_ID!)) {
    issues.push({ key: 'LINE_USER_ID', message: 'LINE_USER_ID 格式不正確（應為 U 開頭加 32 個十六進位字元）。' });
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
