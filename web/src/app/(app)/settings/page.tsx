import type { Metadata } from 'next';
import { setMockScenarioAction, testPushAction } from '@/app/actions';
import { ActionButton } from '@/components/action-button';
import { PriceTargetsCard, type TargetView } from '@/components/price-targets-card';
import { SettingsForm, type BaselineInfo } from '@/components/settings-form';
import { PageHead } from '@/components/site-chrome';
import { EventStatusChip } from '@/components/status-chips';
import { MockScenarioForm } from '@/components/mock-scenario-form';
import { chartPath } from '@/lib/chart/daily-chart';
import { checkEnv, getEnv } from '@/lib/env';
import { formatPrice } from '@/lib/gold/math';
import { PROVIDER_SAFETY_MARGIN } from '@/lib/gold/budget';
import { MOCK_SCENARIOS } from '@/lib/gold/mock-provider';
import { latestDailyPreview } from '@/lib/jobs/chart-data';
import { describeEvent } from '@/lib/jobs/daily';
import { hasIntradayChecks } from '@/lib/schedule';
import { UNIT_LABEL } from '@/lib/gold/types';
import { getPageDeps } from '@/lib/server';
import { formatTaipei, taipeiDate } from '@/lib/time';
import { loadDashboard } from '@/lib/view/dashboard';

export const metadata: Metadata = { title: '推播設定' };
export const dynamic = 'force-dynamic';

const BASIS_SOURCE = { first_valid_of_day: '當日首筆有效報價', previous_close: '前一交易日每日快照', manual: '手動輸入' } as const;

export default async function SettingsPage() {
  const deps = await getPageDeps();
  const env = getEnv();
  const envStatus = checkEnv(env);
  const data = await loadDashboard(deps);
  const s = data.settings;
  const today = taipeiDate(data.now);
  const unit = data.provider.instrument ? `${data.provider.instrument.currency} / ${UNIT_LABEL[data.provider.instrument.unit]}` : '';

  const baselineValid = s.baselinePrice !== null && (s.baselineMode === 'manual' || s.baselineDate === today);
  const baseline: BaselineInfo | null = baselineValid
    ? {
        price: formatPrice(s.baselinePrice),
        unit,
        createdAt: formatTaipei(s.baselineTimestamp),
        source: s.baselineMode === 'first_valid_of_day' && !hasIntradayChecks(s) ? '前一交易日每日快照（只在每日推播時查價）' : BASIS_SOURCE[s.baselineMode],
        nextReset: s.baselineMode === 'manual' ? '不會自動重設' : '下一個台北日期的第一筆有效報價',
      }
    : null;

  // 每日推播預覽：用最新一筆每日快照與它的前一交易日（跟測試推播同一份）
  const preview = await latestDailyPreview(deps);
  const latestDaily = preview?.snapshot ?? null;
  const dailyPreview = preview?.text ?? null;
  const alertEvent = (await deps.store.listEvents({ types: ['alert_up', 'alert_down'], limit: 20 })).find((e) => e.messageText);
  const lastTest = (await deps.store.listEvents({ types: ['test'], limit: 1 }))[0] ?? null;
  const userIdTail = env.LINE_USER_ID && envStatus.line ? env.LINE_USER_ID.slice(-4) : null;

  const quota = data.provider.monthlyCallQuota;
  const targetEvents = new Map(
    (await deps.store.listEvents({ types: ['target'], limit: 50 })).map((e) => [e.id, describeEvent(e)] as const),
  );
  const toView = (t: (typeof data.targets)[number]): TargetView => ({
    id: t.id,
    direction: t.direction,
    targetPrice: t.targetPrice,
    note: t.note,
    status: t.status,
    createdAt: formatTaipei(t.createdAt, false).slice(5),
    triggeredAt: t.triggeredAt ? formatTaipei(t.triggeredAt, false).slice(5) : null,
    triggeredPrice: t.triggeredPrice,
    eventLabel: t.eventId ? targetEvents.get(t.eventId) ?? null : null,
  });
  const checkSummary =
    s.intradayMode === 'times'
      ? `目前在每日推播（${s.dailyPushTime}）與 ${s.checkTimes.join('、')} 檢查。`
      : s.intradayMode === 'interval'
        ? `目前在每日推播與每 ${s.pollingIntervalMinutes} 分鐘檢查。`
        : `目前只在每日推播（${s.dailyPushTime}）時檢查。`;

  return (
    <>
      <div className="on-gold">
        <PageHead eyebrow="Settings" title="推播設定" description="變更在下一次排程生效・所有時間為台北時間" />
      </div>
      <main className="page">
        <div className="row">
          <div className="col-main">
          <SettingsForm
            initial={{
              dailyEnabled: s.dailyEnabled,
              dailyPushTime: s.dailyPushTime,
              alertEnabled: s.alertEnabled,
              riseThresholdPercent: s.riseThresholdPercent,
              fallThresholdPercent: s.fallThresholdPercent,
              intradayMode: s.intradayMode,
              checkTimes: s.checkTimes.join(', '),
              pollingIntervalMinutes: s.pollingIntervalMinutes,
              skipWeekends: s.skipWeekends,
              cooldownMinutes: s.cooldownMinutes,
              baselineMode: s.baselineMode,
              manualBaselinePrice: s.baselineMode === 'manual' && s.baselinePrice ? String(s.baselinePrice) : '',
              linePlan: s.linePlan,
              monthlyMessageQuota: s.monthlyMessageQuota,
              quotaSafetyBuffer: s.quotaSafetyBuffer,
            }}
            baseline={baseline}
            lastSaved={formatTaipei(s.updatedAt, false)}
            provider={{
              name: data.provider.isMock ? 'Mock Provider' : data.provider.name,
              monthlyQuota: quota,
              cap: quota === null ? null : quota - PROVIDER_SAFETY_MARGIN,
            }}
          />
          <PriceTargetsCard
            active={data.targets.map(toView)}
            history={data.targetHistory.map(toView)}
            currentPrice={data.latest && !data.stale ? data.latest.price : null}
            unitLabel={unit || '—'}
            isMock={data.provider.isMock}
            checkSummary={checkSummary}
          />
          </div>

          <div className="col-side">
            <section className={`card card--tight tint ${envStatus.line ? 'tint--green' : 'tint--pink'}`} aria-labelledby="line-h">
              <div className="card-head" style={{ alignItems: 'flex-start' }}>
                <div className="head-stack">
                  <p className="eyebrow">LINE</p>
                  <h2 className="card-title" id="line-h">LINE 連線</h2>
                </div>
                <span className={`chip ${envStatus.line ? 'chip--ok' : 'chip--err'}`}>
                  <span className="dot" />
                  {envStatus.line ? '已設定' : '尚未連線'}
                </span>
              </div>
              <dl className="kv-list">
                <dt>Access Token</dt>
                <dd>{env.LINE_CHANNEL_ACCESS_TOKEN ? '已設定（只存在伺服器端）' : '未設定'}</dd>
                <dt>推播對象</dt>
                <dd>{userIdTail ? <>User ID 已設定・末 4 碼 <span className="num">{userIdTail}</span></> : env.LINE_USER_ID ? 'User ID 格式不正確' : '未設定'}</dd>
              </dl>
              {!envStatus.line ? (
                <p className="small">LINE 尚未連線，每日推播與提醒都只會記錄為「未發送」，不會假裝送出。設定步驟見 README。</p>
              ) : null}
              <div className="divider" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <ActionButton
                  action={testPushAction}
                  label="發送測試推播"
                  confirm="會用掉 1 則 LINE 訊息額度，確定要發送嗎？"
                  hint={`會用掉 1 則訊息額度${data.quota.remaining !== null ? `（保守估算剩餘 ${data.quota.remaining} 則）` : ''}。`}
                />
                {lastTest ? (
                  <p className="small">
                    上次測試：<span className="num">{formatTaipei(lastTest.createdAt, false).slice(5)}</span> <EventStatusChip event={lastTest} />
                  </p>
                ) : null}
              </div>
            </section>

            {data.provider.isMock ? (
              <section className="card card--tight tint tint--yellow" aria-labelledby="mock-h">
                <div className="head-stack">
                  <p className="eyebrow">Mock</p>
                  <h2 className="card-title" id="mock-h">測試情境</h2>
                </div>
                <p className="small">只在使用 Mock Provider 時出現，用來測試上漲、下跌、過期與來源中斷的處理。先在「正常波動」建立今天的基準，再切到急漲或急跌。</p>
                <MockScenarioForm action={setMockScenarioAction} current={s.mockScenario} options={MOCK_SCENARIOS} />
              </section>
            ) : null}

            <section className="card card--tight" aria-labelledby="pv-daily-h">
              <div className="card-head">
                <h2 className="card-label" id="pv-daily-h">每日推播預覽</h2>
                {latestDaily?.status === 'mock' ? <span className="chip chip--mock">模擬資料</span> : null}
              </div>
              {dailyPreview ? <div className="msg">{dailyPreview}</div> : <p className="small soft">尚無每日快照，暫時無法預覽。</p>}
              {preview?.chartAvailable ? (
                // eslint-disable-next-line @next/next/no-img-element -- 動態產生的 PNG，跟 LINE 收到的是同一張
                <img className="msg-chart" src={chartPath(preview.date)} alt={`截至 ${preview.date} 的近期金價走勢圖`} width={1040} height={650} loading="lazy" />
              ) : null}
              {latestDaily ? <p className="caption">取自 {latestDaily.dailyDate} 的每日快照{preview?.chartAvailable ? '；走勢圖會跟文字一起推播（同一則，不另外計算額度）' : ''}。</p> : null}
            </section>

            <section className="card card--tight" aria-labelledby="pv-alert-h">
              <div className="card-head">
                <h2 className="card-label" id="pv-alert-h">異動通知預覽</h2>
                {alertEvent?.messageText?.startsWith('【模擬資料】') ? <span className="chip chip--mock">模擬資料</span> : null}
              </div>
              {alertEvent?.messageText ? (
                <>
                  <div className="msg">{alertEvent.messageText}</div>
                  <p className="caption">取自最近一次異動事件（{formatTaipei(alertEvent.createdAt, false).slice(5)}）。</p>
                </>
              ) : (
                <p className="small soft">還沒有異動事件，達到門檻時會產生。</p>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
