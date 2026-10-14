import { intradayDue } from '../schedule';
import type { JobTrigger } from '../store/types';
import { formatAge } from '../time';
import { ensureBaseline, evaluateAndNotify } from './alerts';
import { safeErrorMessage, type JobDeps, type JobOutcome } from './deps';
import { describeEvent } from './daily';
import { fetchAndRecord } from './snapshot';
import { evaluateTargets } from './targets';

// 盤中檢查：跟每日推播是不同的工作。排程每 15 分鐘呼叫一次，這裡依設定（固定時間或固定間隔）
// 決定要不要真的查價；查到的價格同時判斷百分比異動提醒與到價提醒。

const LOCK_TTL_SECONDS = 120;

export async function runIntradayJob(deps: JobDeps, options: { trigger: JobTrigger }): Promise<JobOutcome> {
  const now = deps.now();
  const settings = await deps.store.getSettings();
  const activeTargets = await deps.store.listPriceTargets({ statuses: ['active'], limit: 1 });

  if (options.trigger === 'cron') {
    if (!settings.alertEnabled && activeTargets.length === 0) {
      return { status: 'disabled', detail: '異動提醒已停用，也沒有到價提醒' };
    }
    const last = await deps.store.getLastJobRun('intraday', ['success', 'skipped', 'failed']);
    const due = intradayDue(settings, now, last?.startedAt ?? null);
    if (!due.due) {
      const disabled = settings.intradayMode === 'off' || due.reason.startsWith('週末');
      return { status: disabled ? 'disabled' : 'not_due', detail: due.reason };
    }
  }

  const owner = deps.newId();
  if (!(await deps.store.tryAcquireLock('intraday', owner, LOCK_TTL_SECONDS))) {
    return { status: 'locked', detail: '另一個盤中檢查正在執行' };
  }

  const run = await deps.store.startJobRun('intraday', options.trigger);
  try {
    const fetched = await fetchAndRecord(deps, settings, options.trigger === 'manual' ? 'manual' : 'check');
    if (fetched.kind === 'error') {
      const status = fetched.code === 'budget' ? 'skipped' : 'failed';
      await deps.store.finishJobRun(run.id, {
        status,
        errorMessage: status === 'failed' ? fetched.message : null,
        detail: status === 'failed' ? '無法取得有效報價，本輪未判斷異動' : fetched.message,
      });
      return { status, detail: fetched.message, jobRunId: run.id };
    }
    const { quote, snapshot, instrument, stale, created, reused } = fetched;

    if (stale) {
      const detail = `報價已過期（${formatAge(quote.timestamp, now)}），暫停異動判斷`;
      await deps.store.finishJobRun(run.id, { status: 'skipped', recordsProcessed: created ? 1 : 0, detail });
      return { status: 'skipped', detail, jobRunId: run.id };
    }

    const baseline = await ensureBaseline(deps, settings, instrument);
    const parts = [reused ? '沿用 10 分鐘內查過的報價' : created ? '寫入 1 筆報價' : '報價未更新，未重複寫入'];
    const eventIds: number[] = [];

    if (!settings.alertEnabled) {
      parts.push('百分比異動提醒已停用');
    } else if (!baseline) {
      parts.push('尚無基準價，暫不判斷百分比異動');
    } else {
      const alert = await evaluateAndNotify(deps, settings, quote, snapshot, baseline);
      if (!alert.decision.trigger) parts.push('未觸發異動提醒');
      else if (alert.duplicate) parts.push('這筆報價已處理過，未重複提醒');
      else if (alert.event) {
        eventIds.push(alert.event.id);
        parts.push(`${alert.decision.direction === 'up' ? '上漲' : '下跌'}提醒：${describeEvent(alert.event)}`);
      }
    }

    for (const t of await evaluateTargets(deps, settings, quote, instrument)) {
      eventIds.push(t.event.id);
      parts.push(`到價提醒（${t.target.direction === 'above' ? '≥' : '≤'} ${t.target.targetPrice}）：${describeEvent(t.event)}`);
    }

    const detail = parts.join('；');
    await deps.store.finishJobRun(run.id, { status: 'success', recordsProcessed: created ? 1 : 0, detail });
    return { status: 'success', detail, jobRunId: run.id, eventIds };
  } catch (err) {
    const message = safeErrorMessage(err);
    await deps.store.finishJobRun(run.id, { status: 'failed', errorMessage: message });
    return { status: 'failed', detail: message, jobRunId: run.id };
  } finally {
    await deps.store.releaseLock('intraday', owner);
  }
}
