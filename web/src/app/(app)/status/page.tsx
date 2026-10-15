import type { Metadata } from 'next';
import Link from 'next/link';
import { backfillAction, retryEventAction, runJobAction } from '@/app/actions';
import { ActionButton } from '@/components/action-button';
import { PageHead } from '@/components/site-chrome';
import { EventStatusChip, eventNote, JobStatusChip, jobLabel } from '@/components/status-chips';
import { checkEnv, getEnv } from '@/lib/env';
import { MAX_TOTAL_ATTEMPTS, RECOVERABLE_SKIPS, RETRY_WINDOW_MS } from '@/lib/jobs/notify';
import { REFERENCE_CHART_URL } from '@/lib/line/messages';
import { estimateMonthlyCalls, hasIntradayChecks } from '@/lib/schedule';
import { getPageDeps } from '@/lib/server';
import type { EventRow, JobType } from '@/lib/store/types';
import { formatAge, formatTaipei, formatTaipeiTime } from '@/lib/time';
import { loadDashboard } from '@/lib/view/dashboard';

export const metadata: Metadata = { title: '系統狀態' };
export const dynamic = 'force-dynamic';

const PLAN_LABEL: Record<string, string> = { light_free: '輕用量（免費）', medium: '中用量', high: '高用量', other: '其他方案' };
const EVENT_LABEL = { daily: '每日行情', alert_up: '上漲提醒', alert_down: '下跌提醒', target: '到價提醒', test: '測試推播' } as const;

function canRetry(e: EventRow, now: Date) {
  const recoverable = e.status === 'failed' || (e.status === 'skipped' && e.skipReason !== null && RECOVERABLE_SKIPS.includes(e.skipReason));
  return recoverable && e.attemptCount < MAX_TOTAL_ATTEMPTS && now.getTime() - e.createdAt.getTime() <= RETRY_WINDOW_MS;
}

export default async function StatusPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const deps = await getPageDeps();
  const env = getEnv();
  const envStatus = checkEnv(env);
  const data = await loadDashboard(deps);
  const { provider, settings, quota } = data;
  const now = data.now;
  const sp = await searchParams;
  const jobFilter: JobType | undefined = sp.job === 'daily' || sp.job === 'intraday' || sp.job === 'quota_sync' ? sp.job : undefined;

  const [locks, runs, events, lastFailedRun, lastSyncAny] = await Promise.all([
    deps.store.getLocks(),
    deps.store.listJobRuns({ jobType: jobFilter, limit: 30 }),
    deps.store.listEvents({ limit: 20 }),
    deps.store.listJobRuns({ status: 'failed', limit: 1 }),
    deps.store.getLatestQuotaSync(),
  ]);
  const lastCalled = (job: string) => locks.find((l) => l.jobType === job)?.lastCalledAt ?? null;
  const dailyCalled = lastCalled('daily');
  const intradayCalled = lastCalled('intraday');
  const intradayExpected = (settings.alertEnabled || data.targets.length > 0) && hasIntradayChecks(settings);
  // 固定時間模式一天只查幾次，心跳看的是排程服務有沒有持續呼叫（每 15 分鐘）
  const heartbeatWindowMs = settings.intradayMode === 'interval' ? 2 * settings.pollingIntervalMinutes * 60_000 + 5 * 60_000 : 45 * 60_000;
  const schedulerOk =
    Boolean(dailyCalled && now.getTime() - dailyCalled.getTime() < 26 * 3600_000) &&
    (!intradayExpected || Boolean(intradayCalled && now.getTime() - intradayCalled.getTime() < heartbeatWindowMs));
  const lastError = lastFailedRun[0] ?? null;
  const sourceFacts =
    provider.id === 'goldapi' && provider.configured
      ? [
          '商品：XAU/USD 現貨，單位 USD／金衡盎司（GoldAPI 上游為 FOREXCOM:XAUUSD；Truney 圖表來自 OANDA／TradingView，數字可能有小差異）',
          '價格與單位：買價與賣價的中價、每金衡盎司（2026-10-14 實測確認；系統每次都會核對回應的 unit 與每公克價格）',
          '歷史資料：週末沿用週五價格的資料會被排除；每日價格不是收盤價，只用於回填與第一次計算前一交易日',
          '授權：已檢視 GoldAPI 服務條款（2026-08-21 版），在自己的應用程式中使用與顯示資料屬允許範圍；不可轉售、轉發 API 或外流金鑰',
          '延遲報價：GoldAPI 沒有提供延遲標記，畫面顯示「供應商未提供」',
          '免費方案每月 100 次請求，本系統最多使用 90 次並優先保留每日推播',
        ]
      : [
          'Truney 圖表使用的商品代號（現貨或期貨、哪個報價源）',
          '價格定義：買價、賣價或中價，以及是否延遲報價',
          '幣別與單位：維持 USD / 金衡盎司，或另外換算成 TWD / 公克（換算需要匯率來源）',
          '候選服務的授權條款：是否允許個人儲存歷史資料與推播',
          '更新頻率、呼叫次數上限與費用',
        ];
  const cap = quota.officialLimit ?? settings.monthlyMessageQuota;

  return (
    <>
      <div className="on-gold">
        <PageHead eyebrow="System" title="系統狀態" description={`頁面更新 ${formatTaipeiTime(now)}・重新整理頁面可看到最新狀態`} />
      </div>
      <main className="page">
        <div className="tiles">
          <section className={`card card--tight tile tint ${provider.isMock ? 'tint--yellow' : provider.configured ? 'tint--green' : 'tint--pink'}`} aria-labelledby="t1">
            <h2 className="card-label" id="t1">行情來源</h2>
            <p className="tile__value">{provider.name}</p>
            <div className="tile__chips">
              <span className={`chip ${provider.configured ? 'chip--ok' : 'chip--err'}`}><span className="dot" />{provider.configured ? '可呼叫' : '未設定'}</span>
              {provider.isMock ? <span className="chip chip--mock">非正式行情</span> : null}
              {provider.configured && !provider.isMock ? <span className={`chip ${provider.licensed ? 'chip--ok' : 'chip--warn'}`}>{provider.licensed ? '授權已確認' : '授權待確認'}</span> : null}
            </div>
            <p className="small soft">{provider.isMock || !provider.configured ? '正式來源：尚未設定' : provider.notes[0] ?? ''}</p>
          </section>
          <section className="card card--tight tile tint tint--cyan" aria-labelledby="t2">
            <h2 className="card-label" id="t2">最近成功報價</h2>
            <p className="tile__value num">{data.latest ? formatTaipeiTime(data.latest.fetchedAt) : '—'}</p>
            <div className="tile__chips">
              {data.latest ? (
                <span className={`chip ${data.stale ? 'chip--warn' : 'chip--ok'}`}><span className="dot" />{data.stale ? '過期' : '有效'}</span>
              ) : (
                <span className="chip chip--muted">尚無資料</span>
              )}
            </div>
            <p className="small soft">{data.latest ? `${formatAge(data.latest.quoteTimestamp, now)}・報價時間 ${formatTaipei(data.latest.quoteTimestamp).slice(5)}` : '還沒有取得任何有效報價'}</p>
          </section>
          <section className="card card--tight tile tint tint--green" aria-labelledby="t3">
            <h2 className="card-label" id="t3">排程</h2>
            <p className="tile__value">{schedulerOk ? '正常' : dailyCalled || intradayCalled ? '需要注意' : '尚未收到排程'}</p>
            <div className="tile__chips">
              <span className={`chip ${dailyCalled ? 'chip--ok' : 'chip--muted'}`}><span className="dot" />每日</span>
              <span className={`chip ${!intradayExpected ? 'chip--muted' : intradayCalled ? 'chip--ok' : 'chip--warn'}`}><span className="dot" />盤中{intradayExpected ? '' : '（未啟用）'}</span>
            </div>
            <p className="small soft">
              每日排程最後呼叫 {dailyCalled ? formatAge(dailyCalled, now) : '—'}；盤中最後呼叫 {intradayCalled ? formatAge(intradayCalled, now) : '—'}
            </p>
          </section>
          <section className="card card--tight tile tint tint--pink" aria-labelledby="t4">
            <h2 className="card-label" id="t4">LINE 推播</h2>
            <p className="tile__value">{envStatus.line ? '已設定' : '尚未連線'}</p>
            <div className="tile__chips">
              <span className={`chip ${quota.pausedReason ? 'chip--warn' : 'chip--ok'}`}><span className="dot" />{quota.pausedReason ? '推播暫停' : '推播未暫停'}</span>
            </div>
            <p className="small soft">{data.lastPush ? `最近推播 ${formatTaipei(data.lastPush.sentAt ?? data.lastPush.updatedAt).slice(5)}` : '還沒有推播紀錄'}</p>
          </section>
        </div>

        <div className="row" id="provider">
          <section className="card col-main" aria-labelledby="prov-h">
            <div className="card-head">
              <div className="head-stack">
                <p className="eyebrow">Data source</p>
                <div className="card-head__title">
                  <h2 className="card-title" id="prov-h">正式行情來源</h2>
                  <span className={`chip ${provider.configured && !provider.isMock ? 'chip--ok' : 'chip--warn'}`}><span className="dot" />{provider.configured && !provider.isMock ? '已設定' : '尚未設定'}</span>
                </div>
              </div>
              <a className="lnk" href={REFERENCE_CHART_URL} target="_blank" rel="noopener noreferrer">Truney 參考圖表 →</a>
            </div>
            <p className="small soft">
              Truney 的圖表由 TradingView 提供，沒有公開 API。本系統不會抓取該頁面，也不會使用 TradingView 的內部請求；正式來源要另外選定有授權的行情服務。
            </p>
            {provider.notes.length ? <ul className="rules">{provider.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            <h3 style={{ fontSize: 14.5, fontWeight: 700 }}>{provider.id === 'goldapi' && provider.configured ? '來源說明' : '待確認事項'}</h3>
            <ul className="checklist">
              {sourceFacts.map((t) => (
                <li key={t}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card col-side" aria-labelledby="env-h">
            <div className="head-stack">
              <p className="eyebrow">Config</p>
              <h2 className="card-title" id="env-h">設定檢查</h2>
            </div>
            {envStatus.issues.length === 0 ? (
              <p className="small">必要的環境變數都已設定。</p>
            ) : (
              <ul className="rules">
                {envStatus.issues.map((i) => (
                  <li key={i.key + i.message}>
                    <span><span className="num">{i.key}</span>：{i.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="caption">這裡只顯示有沒有設定，不會顯示任何金鑰的內容。</p>
          </section>
        </div>

        <section className="card" id="quota" aria-labelledby="quota-h">
          <div className="card-head">
            <div className="head-stack">
              <p className="eyebrow">Quota</p>
              <div className="card-head__title">
                <h2 className="card-title" id="quota-h">LINE 訊息額度</h2>
                <span className={`chip ${quota.pausedReason ? 'chip--warn' : 'chip--ok'}`}><span className="dot" />{quota.pausedReason ? '推播暫停' : '推播未暫停'}</span>
              </div>
            </div>
            <span className="chip chip--muted">不自動升級・不加購</span>
          </div>
          {quota.pausedReason ? <div className="note note--warn"><span>{quota.pausedReason}</span></div> : null}
          {quota.verified && quota.officialUsed !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span>
                  <span className="num" style={{ fontSize: 30, fontWeight: 600 }}>{quota.remaining}</span> <span className="soft">則可用（保守估算）</span>
                </span>
                <span className="small soft">本月已用 {quota.officialUsed} / {cap} 則</span>
              </div>
              <div className="quota-bar" style={{ height: 14, borderRadius: 7 }} role="img" aria-label={`已使用 ${quota.officialUsed} 則，每日推播保留 ${quota.reserveForDaily} 則，共 ${cap} 則`}>
                <span className="quota-bar__used" style={{ width: `${Math.min(100, (quota.officialUsed / cap) * 100)}%` }} />
                <span className="quota-bar__reserve" style={{ width: `${Math.min(100, (quota.reserveForDaily / cap) * 100)}%` }} />
              </div>
              <div className="legend">
                <span><i className="sw-used" />已使用 {quota.officialUsed}</span>
                <span><i className="sw-reserve" />每日推播保留 {quota.reserveForDaily}</span>
                <span><i className="sw-free" />異動提醒可用 {Math.max(0, (quota.remaining ?? 0) - quota.reserveForDaily)}</span>
              </div>
            </div>
          ) : null}
          <dl className="kv divider">
            <div><dt>目前方案（設定）</dt><dd>{PLAN_LABEL[settings.linePlan] ?? settings.linePlan}</dd></div>
            <div><dt>官方可用額度</dt><dd>{quota.officialLimit !== null ? `${quota.officialLimit} 則` : quota.verified ? '官方回報無上限，以設定額度為準' : '尚未取得'}</dd></div>
            <div><dt>本月已使用（LINE 官方）</dt><dd>{quota.officialUsed !== null ? `${quota.officialUsed} 則` : '尚未取得'}<span className="cell-note">官方數字為概略值，含其他管道送出的訊息</span></dd></div>
            <div><dt>本地估算剩餘</dt><dd>{quota.localRemaining} 則<span className="cell-note">設定額度 {settings.monthlyMessageQuota} − 本系統已送出</span></dd></div>
            <div><dt>每日推播保留</dt><dd>{quota.reserveForDaily} 則<span className="cell-note">本月剩餘天數 × 推播人數 {data.recipients} ＋ 緩衝 {settings.quotaSafetyBuffer}</span></dd></div>
            <div><dt>最近同步</dt><dd className="num">{lastSyncAny ? formatTaipei(lastSyncAny.syncedAt) : '—'}<span className="cell-note">{lastSyncAny ? (lastSyncAny.success ? '成功' : `失敗：${lastSyncAny.errorMessage ?? ''}`) : envStatus.line ? '尚未同步' : 'LINE 尚未連線'}</span></dd></div>
            <div><dt>額度重置</dt><dd>每月 1 日（日本時間）<span className="cell-note">台灣時間月底最後一天 23:00 之後送出的算下個月</span></dd></div>
          </dl>
          <div className="action-grid">
            <ActionButton action={runJobAction} fields={{ job: 'quota_sync' }} label="立即同步 LINE 額度" variant="small" />
          </div>
          <p className="caption">官方用量來自 LINE Messaging API（<span className="num">GET /v2/bot/message/quota</span>、<span className="num">/v2/bot/message/quota/consumption</span>）。發送前會自動同步；同步失敗時視為額度不足，暫停推播。</p>
        </section>

        {data.providerBudget.limited ? (
          <section className="card" id="provider-usage" aria-labelledby="usage-h">
            <div className="card-head">
              <div className="head-stack">
                <p className="eyebrow">API usage</p>
                <div className="card-head__title">
                  <h2 className="card-title" id="usage-h">行情 API 查價次數</h2>
                  <span className={`chip ${data.providerBudget.canExtra ? 'chip--ok' : 'chip--warn'}`}>
                    <span className="dot" />
                    {data.providerBudget.canExtra ? '額度充足' : data.providerBudget.canDaily ? '只保留每日推播' : '已達上限'}
                  </span>
                </div>
              </div>
              <span className="chip chip--muted">本地紀錄・每次呼叫前先記錄</span>
            </div>
            {data.providerBudget.reason ? <div className="note note--warn"><span>{data.providerBudget.reason}</span></div> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span>
                  <span className="num" style={{ fontSize: 30, fontWeight: 600 }}>{data.providerBudget.used}</span>{' '}
                  <span className="soft">／ {data.providerBudget.cap} 次（本月，UTC 日曆月）</span>
                </span>
                <span className="small soft">{provider.name} 上限 {data.providerBudget.monthlyQuota} 次，保留 {(data.providerBudget.monthlyQuota ?? 0) - (data.providerBudget.cap ?? 0)} 次緩衝</span>
              </div>
              <div className="quota-bar" style={{ height: 14, borderRadius: 7 }} role="img" aria-label={`已使用 ${data.providerBudget.used} 次，保留給每日推播 ${data.providerBudget.reserveForDaily} 次，上限 ${data.providerBudget.cap} 次`}>
                <span className="quota-bar__used" style={{ width: `${Math.min(100, (data.providerBudget.used / (data.providerBudget.cap || 1)) * 100)}%` }} />
                <span className="quota-bar__reserve" style={{ width: `${Math.min(100, (data.providerBudget.reserveForDaily / (data.providerBudget.cap || 1)) * 100)}%` }} />
              </div>
              <div className="legend">
                <span><i className="sw-used" />已使用 {data.providerBudget.used}</span>
                <span><i className="sw-reserve" />保留給本月每日推播 {data.providerBudget.reserveForDaily}</span>
                <span><i className="sw-free" />盤中檢查可用 {Math.max(0, (data.providerBudget.remaining ?? 0) - data.providerBudget.reserveForDaily)}</span>
              </div>
            </div>
            <p className="caption">
              依目前設定，預估每月約 {estimateMonthlyCalls(settings)} 次。10 分鐘內查過的報價會直接沿用，不重複呼叫；查價失敗也算一次，所以不會自動重試。手動執行、回填也會用掉次數。
            </p>
          </section>
        ) : null}

        <section className="card" aria-labelledby="cost-h">
          <div className="head-stack">
            <p className="eyebrow">Costs</p>
            <h2 className="card-title" id="cost-h">服務與費用</h2>
          </div>
          <div className="table-wrap">
            <table className="tbl tbl--costs tbl--stack">
              <thead>
                <tr><th>服務</th><th>用途</th><th>方案</th><th>費用</th><th>備註</th></tr>
              </thead>
              <tbody>
                <tr><td className="tbl__title">LINE 官方帳號</td><td data-label="用途">每日推播、異動提醒</td><td data-label="方案">{PLAN_LABEL[settings.linePlan] ?? settings.linePlan}</td><td data-label="費用">{settings.linePlan === 'light_free' ? 'NT$0（每月 200 則，用完無法加購）' : '依 LINE 當期價格'}</td><td className="soft" data-label="備註">2026/11/1 起：中用量 NT$1,000／月（3,000 則）、高用量 NT$1,400／月（6,000 則，可加購）；未稅</td></tr>
                <tr><td className="tbl__title">Supabase</td><td data-label="用途">資料庫、排程（pg_cron）</td><td className="soft" data-label="方案">{envStatus.supabase ? '[請填入方案]' : '尚未設定'}</td><td className="soft" data-label="費用">[待確認]</td><td className="soft" data-label="備註">免費方案 7 天沒有活動會暫停；每 15 分鐘的排程呼叫可維持活動</td></tr>
                <tr><td className="tbl__title">Vercel</td><td data-label="用途">網站、每日排程備援</td><td className="soft" data-label="方案">[請填入方案]</td><td className="soft" data-label="費用">[待確認]</td><td className="soft" data-label="備註">Hobby 的 Cron 一天一次、只精確到小時；Pro 為 US$20／月</td></tr>
                <tr>
                  <td className="tbl__title">行情 API</td>
                  <td data-label="用途">正式報價</td>
                  <td data-label="方案">{provider.configured && !provider.isMock ? `${provider.name}${provider.monthlyCallQuota === 100 ? '（Sandbox 免費方案）' : ''}` : '尚未設定'}</td>
                  <td data-label="費用">{provider.id === 'goldapi' ? 'US$0（每月 100 次）' : <span className="soft">[待確認]</span>}</td>
                  <td className="soft" data-label="備註">{provider.id === 'goldapi' ? '付費方案 US$99／月不限次數；本系統不會自動升級' : '選定後補上方案與費用'}</td>
                </tr>
                <tr><td className="tbl__title">Mock Provider</td><td data-label="用途">開發與測試</td><td data-label="方案">—</td><td data-label="費用">無</td><td className="soft" data-label="備註">資料皆為模擬</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="err-h">
          <div className="head-stack">
            <p className="eyebrow">Errors</p>
            <h2 className="card-title" id="err-h">最近一次錯誤</h2>
          </div>
          {lastError ? (
            <div className="note note--err">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span><span className="num">{formatTaipei(lastError.startedAt)}</span>・{jobLabel(lastError.jobType)}</span>
                <b>{lastError.errorMessage ?? '未知錯誤'}</b>
                {lastError.detail ? <span className="small">{lastError.detail}</span> : null}
              </div>
            </div>
          ) : (
            <p className="small">目前沒有錯誤紀錄。</p>
          )}
          <p className="caption">這裡只顯示錯誤摘要，不顯示伺服器堆疊或任何金鑰。</p>
        </section>

        <section className="card" id="jobs" aria-labelledby="jobs-h">
          <div className="card-head">
            <div className="head-stack">
              <p className="eyebrow">Job runs</p>
              <h2 className="card-title" id="jobs-h">排程執行紀錄</h2>
            </div>
            <nav className="seg" aria-label="篩選工作類型">
              {[
                ['', '全部'],
                ['daily', '每日快照'],
                ['intraday', '盤中檢查'],
                ['quota_sync', '額度同步'],
              ].map(([v, l]) => (
                <Link key={v} className="seg__btn" href={v ? `/status?job=${v}#jobs` : '/status#jobs'} aria-current={(jobFilter ?? '') === v ? 'page' : undefined} aria-pressed={(jobFilter ?? '') === v} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                  {l}
                </Link>
              ))}
            </nav>
          </div>
          <div className="action-grid">
            <ActionButton action={runJobAction} fields={{ job: 'daily' }} label="立即執行每日排程" variant="small" hint="今天已推播過就不會重複送出" />
            <ActionButton action={runJobAction} fields={{ job: 'intraday' }} label="立即執行盤中檢查" variant="small" />
            {provider.configured ? <ActionButton action={backfillAction} label={`回填近 90 天${provider.isMock ? '（模擬資料）' : ''}`} variant="small" hint="只補沒有的日期，不覆蓋" /> : null}
          </div>
          {runs.length === 0 ? (
            <p className="small soft">還沒有排程紀錄。</p>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl--jobs tbl--stack">
                <thead>
                  <tr><th>工作</th><th>開始</th><th>結束</th><th className="r">耗時</th><th>狀態</th><th className="r">處理筆數</th><th>說明</th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="tbl__title">{jobLabel(r.jobType)}<span className="cell-note num">{r.trigger === 'manual' ? '手動' : 'cron'}</span></td>
                      <td className="num nowrap" data-label="開始">{formatTaipei(r.startedAt).slice(5)}</td>
                      <td className="num nowrap" data-label="結束">{r.finishedAt ? formatTaipeiTime(r.finishedAt) : '—'}</td>
                      <td className="num r" data-label="耗時">{r.finishedAt ? `${((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)} 秒` : '—'}</td>
                      <td data-label="狀態"><JobStatusChip run={r} /></td>
                      <td className="num r" data-label="處理筆數">{r.recordsProcessed}</td>
                      <td data-label="說明">{r.errorMessage ? <span style={{ color: 'var(--err)' }}>{r.errorMessage}</span> : null}{r.detail ? <span className="cell-note">{r.detail}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" id="events" aria-labelledby="events-h">
          <div className="head-stack">
            <p className="eyebrow">Notifications</p>
            <h2 className="card-title" id="events-h">通知事件</h2>
          </div>
          {events.length === 0 ? (
            <p className="small soft">還沒有通知事件。</p>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl--jobs tbl--stack">
                <thead>
                  <tr><th>時間</th><th>類型</th><th>事件鍵</th><th className="r">嘗試次數</th><th>狀態</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="num nowrap tbl__title">{formatTaipei(e.createdAt).slice(5)}</td>
                      <td data-label="類型">{EVENT_LABEL[e.eventType]}</td>
                      <td className="num small" data-label="事件鍵">{e.idempotencyKey.length > 40 ? `${e.idempotencyKey.slice(0, 40)}…` : e.idempotencyKey}</td>
                      <td className="num r" data-label="嘗試次數">{e.attemptCount}</td>
                      <td data-label="狀態"><EventStatusChip event={e} /><span className="cell-note">{eventNote(e)}</span></td>
                      <td data-label="操作">{canRetry(e, now) ? <ActionButton action={retryEventAction} fields={{ eventId: String(e.id) }} label="重試" variant="small" /> : <span className="small soft">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="caption">重試會沿用原本的 LINE retry key（24 小時內有效），已送達的訊息不會重複送出；每則事件最多嘗試 {MAX_TOTAL_ATTEMPTS} 次。</p>
        </section>
      </main>
    </>
  );
}
