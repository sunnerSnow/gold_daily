import type { Metadata } from 'next';
import Link from 'next/link';
import { backfillAction, runJobAction } from '@/app/actions';
import { ActionButton } from '@/components/action-button';
import { PriceChart } from '@/components/price-chart';
import { EventStatusChip, eventNote, JobStatusChip, jobLabel } from '@/components/status-chips';
import { Ticker, type TickerItem } from '@/components/ticker';
import { checkEnv, getEnv } from '@/lib/env';
import { formatPercent, formatPrice, formatSigned } from '@/lib/gold/math';
import { UNIT_LABEL } from '@/lib/gold/types';
import { REFERENCE_CHART_URL } from '@/lib/line/messages';
import { getPageDeps } from '@/lib/server';
import { formatAge, formatTaipei, formatTaipeiTime, taipeiDate } from '@/lib/time';
import { loadDashboard, type DashboardData } from '@/lib/view/dashboard';

export const metadata: Metadata = { title: '儀表板' };
export const dynamic = 'force-dynamic';

const BASIS_LABEL = { first_valid_of_day: '當日首筆有效報價', previous_close: '前一交易日參考價', manual: '手動指定' } as const;

export default async function DashboardPage() {
  const data = await loadDashboard(await getPageDeps());
  if (!data.latest) return <FirstRun data={data} />;
  return <Dashboard data={data} />;
}

function Dashboard({ data }: { data: DashboardData }) {
  const { latest, provider, settings, change, gauge, quota } = data;
  if (!latest) return null;
  const unit = `${latest.currency} / ${UNIT_LABEL[latest.unit]}`;
  const up = (change?.amount ?? 0) >= 0;
  const tone = change ? (up ? 'up' : 'down') : '';
  const today = taipeiDate(data.now);

  const ticker: TickerItem[] = [
    { label: provider.isMock ? '金價（模擬）' : '金價', value: `${formatPrice(latest.price)}${change ? `  ${up ? '▲' : '▼'} ${formatPercent(change.percent)}` : ''}`, tone: change ? (up ? 'up' : 'down') : undefined },
    { label: '前一交易日', value: formatPrice(data.reference?.price) },
    ...(gauge
      ? [
          { label: '今日基準', value: formatPrice(gauge.baseline) },
          { label: '上漲提醒', value: `≥ ${formatPrice(gauge.riseAt)}` },
          { label: '下跌提醒', value: `≤ ${formatPrice(gauge.fallAt)}` },
        ]
      : []),
    ...data.targets.map((t) => ({ label: '到價提醒', value: `${t.direction === 'above' ? '≥' : '≤'} ${formatPrice(t.targetPrice)}` })),
    ...(data.nextIntradayAt ? [{ label: '下次查價', value: formatTaipei(data.nextIntradayAt, false).slice(5) }] : []),
    { label: '每日推播', value: settings.dailyEnabled ? settings.dailyPushTime : '已停用' },
    { label: 'LINE 本月', value: quota.officialUsed !== null ? `${quota.officialUsed} 則` : '未同步' },
  ];

  return (
    <>
      <h1 className="visually-hidden">儀表板</h1>
      <section className="hero on-gold" aria-labelledby="price-h">
        <div className="hero__main">
          {data.stale ? (
            <div className="note note--warn" role="alert">
              <WarnIcon />
              <span>
                <b>報價已過期。</b>最後有效報價是 {formatAge(latest.quoteTimestamp, data.now)}（超過 {provider.staleAfterMinutes} 分鐘），行情來源沒有更新。下方不是最新價格，盤中異動判斷已暫停。
              </span>
            </div>
          ) : null}
          <p className="eyebrow">Today・{formatTaipei(data.now, false).slice(5, 10)}・頁面更新 {formatTaipeiTime(data.now)}</p>
          <div className="hero__label">
            <h2 id="price-h">黃金價格</h2>
            <span className="num small soft">{latest.symbol}</span>
            {data.stale ? (
              <span className="chip chip--warn"><span className="dot" />過期</span>
            ) : (
              <span className="chip chip--ok"><span className="dot" />{latest.status === 'delayed' ? '有效・延遲' : '有效'}</span>
            )}
            {latest.status === 'mock' ? <span className="chip chip--mock">模擬資料</span> : null}
          </div>
          <div className="price-line">
            <span className={`price-hero${data.stale ? ' is-stale' : ''}`}>{formatPrice(latest.price)}</span>
            <span className="soft">{unit}</span>
          </div>
          <div className="hero__change">
            {change ? (
              <span className="change-pill">
                <span className={`num ${tone}`}>{up ? '▲' : '▼'} {formatSigned(change.amount)}</span>
                <span className={`num ${tone}`}>{formatPercent(change.percent)}</span>
              </span>
            ) : (
              <span className="change-pill"><span className="small">無法計算漲跌</span></span>
            )}
            <span className="small soft">
              {data.reference
                ? <>較前一交易日（{data.reference.dailyDate?.slice(5).replace('-', '/')}）參考價 <span className="num">{formatPrice(data.reference.price)}</span></>
                : '尚無前一交易日的有效參考價'}
            </span>
          </div>
          <ul className="meta-pills" aria-label="報價資訊">
            <li className="meta-pill"><b>報價時間</b><span className="num">{formatTaipei(latest.quoteTimestamp)}</span></li>
            <li className="meta-pill"><b>系統取得</b><span className="num">{formatTaipei(latest.fetchedAt)}</span></li>
            <li className="meta-pill"><b>新鮮度</b><span>{formatAge(latest.quoteTimestamp, data.now)}（{provider.staleAfterMinutes} 分鐘內有效）</span></li>
            <li className="meta-pill"><b>延遲報價</b><span>{latest.isDelayed === null ? '供應商未提供' : latest.isDelayed ? '是' : '否'}</span></li>
            <li className="meta-pill"><b>來源</b><span>{provider.isMock ? 'Mock Provider（測試用）' : provider.name}</span></li>
            <li className="meta-pill"><a href={REFERENCE_CHART_URL} target="_blank" rel="noopener noreferrer">Truney 參考圖表 ↗</a></li>
          </ul>
        </div>

        <aside className="card hero__side" style={{ gap: 16 }} aria-labelledby="base-h">
          <div className="card-head">
            <div className="head-stack">
              <p className="eyebrow">Alert baseline</p>
              <h2 className="card-title" id="base-h">異動提醒基準</h2>
            </div>
            <span className={`chip ${settings.alertEnabled ? 'chip--ok' : 'chip--muted'}`}>{settings.alertEnabled ? '提醒啟用' : '提醒停用'}</span>
          </div>
          {gauge ? (
            <>
              <div>
                <div className="num" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.2 }}>{formatPrice(gauge.baseline)}</div>
                <div className="small soft">
                  {BASIS_LABEL[gauge.basis]}
                  {gauge.baselineAt && gauge.basis !== 'manual' ? <>・<span className="num">{formatTaipei(gauge.baselineAt).slice(5)}</span></> : null}
                </div>
              </div>
              <div className={`gauge${gauge.position === null ? ' is-paused' : ''}`}>
                <div className="gauge__track">
                  <span className="gauge__end gauge__end--down" />
                  <span className="gauge__end gauge__end--up" />
                  <span className="gauge__mid" style={{ left: `${gauge.center}%` }} />
                  <span className="gauge__bubble num" style={{ left: `${gauge.position ?? gauge.center}%` }}>
                    {gauge.vsBase === null ? '暫停判斷' : formatPercent(gauge.vsBase)}
                  </span>
                  <span className="gauge__marker" style={{ left: `${gauge.position ?? gauge.center}%` }} />
                </div>
                <div className="gauge__labels">
                  <div><b className="down">▼ 下跌 {settings.fallThresholdPercent}%</b><span className="num">{formatPrice(gauge.fallAt)}</span></div>
                  <div style={{ textAlign: 'center' }}><b>基準</b><span className="num">{formatPrice(gauge.baseline)}</span></div>
                  <div style={{ textAlign: 'right' }}><b className="up">▲ 上漲 {settings.riseThresholdPercent}%</b><span className="num">{formatPrice(gauge.riseAt)}</span></div>
                </div>
              </div>
              <p style={{ fontSize: 14 }}>
                {gauge.vsBase === null
                  ? '報價過期，暫停異動判斷；來源恢復後會用新報價重新判斷。'
                  : `目前價格相對基準 ${formatPercent(gauge.vsBase)}，${Math.abs(gauge.vsBase) >= Math.min(settings.riseThresholdPercent, settings.fallThresholdPercent) ? '已達門檻附近' : '未達門檻'}。`}
              </p>
            </>
          ) : (
            <p className="small soft">今天還沒有基準價。{settings.baselineMode === 'manual' ? '請到推播設定輸入手動基準。' : '下一筆有效報價會依規則建立基準。'}</p>
          )}
          <dl className="kv-list divider">
            <dt>查價時間</dt>
            <dd>
              {settings.intradayMode === 'times'
                ? `每日推播（${settings.dailyPushTime}）＋ ${settings.checkTimes.join('、')}`
                : settings.intradayMode === 'interval'
                  ? `每 ${settings.pollingIntervalMinutes} 分鐘`
                  : `只在每日推播（${settings.dailyPushTime}）`}
              {data.nextIntradayAt ? <>・下次 <span className="num">{formatTaipei(data.nextIntradayAt, false).slice(5)}</span></> : null}
            </dd>
            <dt>冷卻時間</dt>
            <dd>同方向 {settings.cooldownMinutes} 分鐘</dd>
            <dt>基準規則</dt>
            <dd>{BASIS_LABEL[settings.baselineMode]}</dd>
          </dl>
          <div className="divider" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span className="small" style={{ fontWeight: 700 }}>到價提醒</span>
              <Link className="lnk" href="/settings#targets-h">設定 →</Link>
            </div>
            {data.targets.length === 0 ? (
              <span className="small soft">目前沒有到價提醒。</span>
            ) : (
              data.targets.slice(0, 4).map((t) => (
                <span key={t.id} className="small">
                  <span className={t.direction === 'above' ? 'up' : 'down'}>{t.direction === 'above' ? '▲ 漲到' : '▼ 跌到'}</span>{' '}
                  <span className="num">{formatPrice(t.targetPrice)}</span>
                  {latest && !data.stale ? <span className="soft">（距離 {formatPercent(((t.targetPrice - latest.price) / latest.price) * 100)}）</span> : null}
                </span>
              ))
            )}
          </div>
          <p className="help">提醒只在查價時間判斷，不能保證在價格觸及門檻的當下通知。</p>
        </aside>
      </section>

      <main className="page">
        <Ticker items={ticker} label={`重點數據${provider.isMock ? '（模擬資料）' : ''}`} />

        <PriceChart points={data.history} today={today} isMock={provider.isMock} />

        <div className="row">
          <section className="card col-main" style={{ gap: 14 }} aria-labelledby="ev-h">
            <div className="card-head" style={{ alignItems: 'flex-end' }}>
              <div className="head-stack">
                <p className="eyebrow">Alerts</p>
                <h2 className="card-title" id="ev-h">最近價格異動事件</h2>
              </div>
              <Link className="lnk" href="/status#events">全部紀錄 →</Link>
            </div>
            {data.alerts.length === 0 ? (
              <div className="empty">
                <span className="empty__title">尚無異動事件</span>
                <span className="empty__text">價格漲跌達到門檻、或到達你設定的目標價時才會產生事件。</span>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="tbl tbl--events">
                  <thead>
                    <tr><th>觸發時間</th><th>方向</th><th className="r">價格</th><th className="r">相對基準</th><th>門檻</th><th>發送狀態</th></tr>
                  </thead>
                  <tbody>
                    {data.alerts.map((e) => {
                      if (e.eventType === 'target') {
                        const above = (e.currentPrice ?? 0) >= (e.baselinePrice ?? 0);
                        return (
                          <tr key={e.id}>
                            <td className="num nowrap">{formatTaipei(e.createdAt, false).slice(5)}</td>
                            <td className="nowrap">◎ 到價</td>
                            <td className="num r">{formatPrice(e.currentPrice)}</td>
                            <td className="num r soft">—</td>
                            <td className="nowrap">{above ? '≥' : '≤'} {formatPrice(e.baselinePrice)}</td>
                            <td><EventStatusChip event={e} /><span className="cell-note">{eventNote(e)}</span></td>
                          </tr>
                        );
                      }
                      const dirUp = e.eventType === 'alert_up';
                      return (
                        <tr key={e.id}>
                          <td className="num nowrap">{formatTaipei(e.createdAt, false).slice(5)}</td>
                          <td className={`nowrap ${dirUp ? 'up' : 'down'}`}>{dirUp ? '▲ 上漲' : '▼ 下跌'}</td>
                          <td className="num r">{formatPrice(e.currentPrice)}</td>
                          <td className={`num r ${dirUp ? 'up' : 'down'}`}>{formatPercent(e.changePercent)}</td>
                          <td className="nowrap">{dirUp ? '上漲' : '下跌'} ≥ {e.thresholdPercent}%</td>
                          <td><EventStatusChip event={e} /><span className="cell-note">{eventNote(e)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="caption">每個事件以 idempotency key 去重，排程重試或系統重啟都不會重複推播；同方向在冷卻時間內只記一筆「冷卻中・未發送」。</p>
          </section>

          <div className="col-side">
            <section className="card card--tight tint tint--cyan" aria-labelledby="job-h">
              <div className="card-head" style={{ alignItems: 'flex-start' }}>
                <div className="head-stack">
                  <p className="eyebrow">Jobs</p>
                  <h2 className="card-title" id="job-h">最近一次排程</h2>
                </div>
                {data.lastRun ? <JobStatusChip run={data.lastRun} /> : null}
              </div>
              {data.lastRun ? (
                <div>
                  <div style={{ fontWeight: 700 }}>{jobLabel(data.lastRun.jobType)}</div>
                  <div className="num small soft">
                    {formatTaipei(data.lastRun.startedAt).slice(5)} → {data.lastRun.finishedAt ? formatTaipeiTime(data.lastRun.finishedAt) : '執行中'}
                    {data.lastRun.trigger === 'manual' ? '（手動）' : ''}
                  </div>
                  <div className="small">{data.lastRun.errorMessage ?? data.lastRun.detail}</div>
                </div>
              ) : (
                <p className="small">還沒有任何排程紀錄。</p>
              )}
              <Link className="lnk" href="/status#jobs">排程執行紀錄 →</Link>
            </section>

            <section className="card card--tight tint tint--green" aria-labelledby="line-h">
              <div className="card-head" style={{ alignItems: 'flex-start' }}>
                <div className="head-stack">
                  <p className="eyebrow">LINE</p>
                  <h2 className="card-title" id="line-h">最近一次推播</h2>
                </div>
                {data.lastPush ? <EventStatusChip event={data.lastPush} /> : null}
              </div>
              {data.lastPush ? (
                <div>
                  <div style={{ fontWeight: 700 }}>{{ daily: '每日行情', alert_up: '上漲提醒', alert_down: '下跌提醒', target: '到價提醒', test: '測試推播' }[data.lastPush.eventType]}</div>
                  <div className="num small soft">{formatTaipei(data.lastPush.sentAt ?? data.lastPush.updatedAt)}</div>
                  <div className="small">{eventNote(data.lastPush)}</div>
                </div>
              ) : (
                <p className="small">還沒有送出過訊息。</p>
              )}
              <QuotaMini data={data} />
              <Link className="lnk" href="/settings">推播設定 →</Link>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

function QuotaMini({ data }: { data: DashboardData }) {
  const q = data.quota;
  const cap = q.officialLimit ?? data.settings.monthlyMessageQuota;
  const used = q.officialUsed;
  return (
    <div className="divider" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="small soft">本月訊息額度</span>
        <span>
          <span className="num" style={{ fontSize: 18, fontWeight: 600 }}>{used ?? '—'}</span>
          <span className="num soft"> / {cap} 則</span>
        </span>
      </div>
      {used !== null ? (
        <div className="quota-bar" style={{ background: 'var(--surface)' }} role="img" aria-label={`已使用 ${used} 則，每日推播保留 ${q.reserveForDaily} 則，共 ${cap} 則`}>
          <span className="quota-bar__used" style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
          <span className="quota-bar__reserve" style={{ width: `${Math.min(100, (q.reserveForDaily / cap) * 100)}%` }} />
        </div>
      ) : null}
      <div className="caption">
        {q.lastSyncAt ? <>LINE 官方用量同步 <span className="num">{formatTaipei(q.lastSyncAt).slice(5)}</span>・</> : null}
        {q.pausedReason ?? '推播未暫停'}
      </div>
    </div>
  );
}

function FirstRun({ data }: { data: DashboardData }) {
  const env = checkEnv(getEnv());
  const steps = [
    { title: '資料庫（Supabase）', done: env.supabase, chip: env.supabase ? ['chip--ok', '已連線'] : ['chip--warn', '使用記憶體'], desc: env.supabase ? '資料會保存在 Supabase。' : '未設定 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY，資料只存在記憶體，重啟就清空。' },
    { title: '行情來源', done: data.provider.configured && !data.provider.isMock, chip: data.provider.isMock ? ['chip--mock', '使用 Mock'] : data.provider.configured ? ['chip--ok', '已設定'] : ['chip--err', '未設定'], desc: data.provider.isMock ? 'GOLD_PRICE_PROVIDER=mock。正式來源要先確認授權，進度見系統狀態。' : data.provider.notes.join(' ') },
    { title: 'LINE 推播', done: env.line, chip: env.line ? ['chip--ok', '已設定'] : ['chip--err', '尚未連線'], desc: env.line ? '已設定 Channel Access Token 與 User ID。' : '缺少 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_USER_ID。設定完成前不會送出任何訊息，步驟見 README。' },
    { title: '排程授權', done: env.cron, chip: env.cron ? ['chip--ok', '已設定'] : ['chip--err', '未設定'], desc: env.cron ? '排程 API 需帶 Authorization: Bearer CRON_SECRET。' : '缺少 CRON_SECRET（至少 16 字元），排程 API 會拒絕所有請求。' },
    { title: '第一筆每日快照', done: false, chip: ['chip--muted', '尚未執行'], desc: '' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <>
      <section className="hero on-gold" aria-labelledby="welcome-h">
        <div className="hero__main">
          <p className="eyebrow">Welcome・首次啟動</p>
          <h1 className="hero__title" id="welcome-h">歡迎使用 Gold Daily</h1>
          <p className="hero__lead">完成下面的設定後，系統會在每天 {data.settings.dailyPushTime} 記錄金價、推播到 LINE，並在漲跌達到門檻時提醒你。</p>
          <div className="progress" role="img" aria-label={`設定進度：完成 ${doneCount} 項，共 ${steps.length} 項`}>
            {steps.map((s, i) => <span key={i} className={s.done ? 'is-on' : ''} />)}
          </div>
          <p className="small soft">完成 <span className="num">{doneCount}</span> / <span className="num">{steps.length}</span></p>
        </div>
        <aside className="card hero__side" aria-labelledby="price-h">
          <div className="card-head" style={{ alignItems: 'flex-start' }}>
            <div className="head-stack">
              <p className="eyebrow">Price</p>
              <h2 className="card-title" id="price-h">黃金價格</h2>
            </div>
            <span className="chip chip--muted">無資料</span>
          </div>
          <div className="price-line">
            <span className="price-big is-empty">—</span>
            <span className="soft">{data.provider.instrument ? `${data.provider.instrument.currency} / ${UNIT_LABEL[data.provider.instrument.unit]}` : '單位未定'}</span>
          </div>
          <p className="small soft">還沒有有效報價。第一次排程執行並通過驗證後才會顯示，不會先放假數字。</p>
        </aside>
      </section>
      <main className="page">
        <section className="card" aria-labelledby="setup-h">
          <div className="card-head" style={{ alignItems: 'flex-end' }}>
            <div className="head-stack">
              <p className="eyebrow">Setup</p>
              <h2 className="card-title" id="setup-h">開始前的設定</h2>
            </div>
          </div>
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? 'is-done' : i === steps.findIndex((x) => !x.done) ? 'is-active' : ''}>
                <span className="steps__title">{s.title}</span>
                <span className={`chip ${s.chip[0]}`}>{s.chip[1]}</span>
                {i === steps.length - 1 ? (
                  <span className="steps__desc" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
                    <ActionButton action={runJobAction} fields={{ job: 'daily' }} label="立即執行一次每日排程" hint="會照常寫入快照；LINE 未連線時不會推播。" />
                    {data.provider.isMock ? <ActionButton action={backfillAction} label="回填近 90 天（模擬資料）" hint="用 Mock Provider 產生標示為模擬的歷史資料。" /> : null}
                  </span>
                ) : (
                  <span className="steps__desc">{s.desc}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
        <PriceChart points={[]} today={taipeiDate(data.now)} isMock={data.provider.isMock} />
      </main>
    </>
  );
}

function WarnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2 21h20L12 3z" />
      <path d="M12 10v5" />
      <path d="M12 18h.01" />
    </svg>
  );
}
