import { describeLine, describeTelegram } from '@/lib/jobs/daily';
import type { EventRow, JobRunRow } from '@/lib/store/types';

// 事件與排程狀態的標籤。狀態一律有文字，不只靠顏色。

/** LINE 沒設定、只送 Telegram 的事件：LINE 那一邊不用顯示 */
const lineOff = (e: EventRow) => e.status === 'skipped' && e.skipReason === 'line_not_configured';

function LineChip({ event, prefix }: { event: EventRow; prefix: string }) {
  const cls =
    event.status === 'sent'
      ? event.attemptCount > 1
        ? 'chip--warn'
        : 'chip--ok'
      : event.status === 'failed'
        ? 'chip--err'
        : event.status === 'skipped' && event.skipReason !== 'cooldown'
          ? 'chip--warn'
          : 'chip--muted';
  const label = event.status === 'sent' && event.attemptCount > 1 ? '重試後送出' : describeLine(event);
  return <span className={`chip ${cls}`}>{prefix}{label}</span>;
}

function TelegramChip({ event }: { event: EventRow }) {
  const cls =
    event.telegramStatus === 'sent'
      ? event.telegramAttemptCount > 1
        ? 'chip--warn'
        : 'chip--ok'
      : event.telegramStatus === 'failed'
        ? 'chip--err'
        : 'chip--muted';
  const label = event.telegramStatus === 'sent' && event.telegramAttemptCount > 1 ? '重試後送出' : describeTelegram(event);
  return <span className={`chip ${cls}`}>Telegram {label}</span>;
}

/** 沒有送 Telegram 的事件跟原本一樣只顯示 LINE；有送時兩邊各一個標籤 */
export function EventStatusChip({ event }: { event: EventRow }) {
  if (event.telegramStatus === null) return <LineChip event={event} prefix="" />;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      {lineOff(event) ? null : <LineChip event={event} prefix="LINE " />}
      <TelegramChip event={event} />
    </span>
  );
}

function lineNote(event: EventRow): string {
  if (event.status === 'sent') return `第 ${event.attemptCount} 次嘗試送達`;
  if (event.lastError) return event.lastError;
  if (event.status === 'failed') return `已嘗試 ${event.attemptCount} 次`;
  return '';
}

function telegramNote(event: EventRow): string {
  if (event.telegramStatus === 'sent') return `第 ${event.telegramAttemptCount} 次嘗試送達${event.telegramLastError ? `（${event.telegramLastError}）` : ''}`;
  if (event.telegramLastError) return event.telegramLastError;
  if (event.telegramStatus === 'failed') return `已嘗試 ${event.telegramAttemptCount} 次`;
  return '';
}

export function eventNote(event: EventRow): string {
  if (event.telegramStatus === null) return lineNote(event);
  const telegram = telegramNote(event);
  if (lineOff(event)) return telegram;
  const line = lineNote(event);
  return [line ? `LINE：${line}` : '', telegram ? `Telegram：${telegram}` : ''].filter(Boolean).join('；');
}

const JOB_LABEL: Record<JobRunRow['jobType'], string> = {
  daily: '每日快照',
  intraday: '盤中檢查',
  quota_sync: '額度同步',
};

export const jobLabel = (t: JobRunRow['jobType']) => JOB_LABEL[t];

export function JobStatusChip({ run }: { run: JobRunRow }) {
  const map: Record<JobRunRow['status'], [string, string]> = {
    running: ['chip--muted', '執行中'],
    success: ['chip--ok', '成功'],
    skipped: ['chip--warn', '略過'],
    failed: ['chip--err', '失敗'],
  };
  const [cls, label] = map[run.status];
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
