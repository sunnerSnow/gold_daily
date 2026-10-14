// 排程與顯示一律用台北時間；資料庫存 UTC。台灣沒有日光節約時間，但仍透過 Intl 換算，不手寫 +8。

export const TIMEZONE = 'Asia/Taipei';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface TaipeiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function taipeiParts(date: Date): TaipeiParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 台北日期，格式 YYYY-MM-DD */
export function taipeiDate(date: Date): string {
  const p = taipeiParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 台北當天 00:00 對應的 UTC 時刻 */
export function startOfTaipeiDay(date: Date): Date {
  const p = taipeiParts(date);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  // 用實際時區偏移修正，避免寫死 +8
  const offsetMs = taipeiOffsetMs(new Date(guess));
  return new Date(guess - offsetMs);
}

/** 台北當月 1 日 00:00 對應的 UTC 時刻 */
export function startOfTaipeiMonth(date: Date): Date {
  const p = taipeiParts(date);
  const guess = Date.UTC(p.year, p.month - 1, 1);
  return new Date(guess - taipeiOffsetMs(new Date(guess)));
}

function taipeiOffsetMs(date: Date): number {
  const p = taipeiParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 台北時間當天已經過的分鐘數 */
export function taipeiMinutesOfDay(date: Date): number {
  const p = taipeiParts(date);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" 轉成分鐘數；格式錯誤回傳 null */
export function parseHhmm(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 本月（台北）在今天之後還剩幾天 */
export function remainingDaysInTaipeiMonth(date: Date): number {
  const p = taipeiParts(date);
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return daysInMonth - p.day;
}

// LINE 的訊息用量以日本時間（GMT+9）計月：台灣時間月底最後一天 23:00 之後送出的算下個月。
// https://help2.line.me/official_account_tw/ios/categoryId/20006396/3/pc?lang=zh-Hant
export const LINE_BILLING_TIMEZONE = 'Asia/Tokyo';

const tokyoFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LINE_BILLING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function tokyoYmd(date: Date) {
  const map: Record<string, string> = {};
  for (const p of tokyoFormatter.formatToParts(date)) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/** LINE 計費月份的起點（日本時間當月 1 日 00:00） */
export function startOfLineBillingMonth(date: Date): Date {
  const p = tokyoYmd(date);
  return new Date(Date.UTC(p.year, p.month - 1, 1) - 9 * 3600_000);
}

/** LINE 計費月份在今天之後還剩幾天（日本時間） */
export function remainingDaysInLineBillingMonth(date: Date): number {
  const p = tokyoYmd(date);
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate() - p.day;
}

/** 前一天的台北日期字串 */
export function previousDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = '日一二三四五六';

/** 2026/10/13 10:30:00 */
export function formatTaipei(date: Date | string | null | undefined, withSeconds = true): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  const p = taipeiParts(d);
  const time = withSeconds ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` : `${pad(p.hour)}:${pad(p.minute)}`;
  return `${p.year}/${pad(p.month)}/${pad(p.day)} ${time}`;
}

/** 10:30:00 */
export function formatTaipeiTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  const p = taipeiParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 2026/10/13（二），輸入為 YYYY-MM-DD */
export function formatDateLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${isoDate.replaceAll('-', '/')}（${WEEKDAYS[d.getUTCDay()]}）`;
}

/** 12 分鐘前、2 小時 42 分鐘前 */
export function formatAge(from: Date | string, now: Date): string {
  const d = typeof from === 'string' ? new Date(from) : from;
  const minutes = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
  if (minutes < 1) return '不到 1 分鐘前';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} 小時 ${minutes % 60} 分鐘前` : `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}
