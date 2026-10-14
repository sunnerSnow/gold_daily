import { describeEvent } from '@/lib/jobs/daily';
import type { EventRow, JobRunRow } from '@/lib/store/types';

// 事件與排程狀態的標籤。狀態一律有文字，不只靠顏色。

export function EventStatusChip({ event }: { event: EventRow }) {
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
  const label = event.status === 'sent' && event.attemptCount > 1 ? '重試後送出' : describeEvent(event);
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function eventNote(event: EventRow): string {
  if (event.status === 'sent') return `第 ${event.attemptCount} 次嘗試送達`;
  if (event.lastError) return event.lastError;
  if (event.status === 'failed') return `已嘗試 ${event.attemptCount} 次`;
  return '';
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
