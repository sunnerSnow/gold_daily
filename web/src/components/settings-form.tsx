'use client';

import { startTransition, useActionState, useState } from 'react';
import { resetBaselineAction, saveSettingsAction } from '@/app/actions';

// 推播設定表單。伺服器端用 Zod 驗證，錯誤訊息逐欄顯示；停用的區塊沿用原本的值。

export interface SettingsFormValues {
  dailyEnabled: boolean;
  dailyPushTime: string;
  alertEnabled: boolean;
  riseThresholdPercent: number;
  fallThresholdPercent: number;
  intradayMode: 'times' | 'interval' | 'off';
  checkTimes: string;
  pollingIntervalMinutes: 0 | 15 | 30 | 60;
  skipWeekends: boolean;
  cooldownMinutes: number;
  baselineMode: 'first_valid_of_day' | 'previous_close' | 'manual';
  manualBaselinePrice: string;
  linePlan: string;
  monthlyMessageQuota: number;
  quotaSafetyBuffer: number;
}

export interface BaselineInfo {
  price: string;
  unit: string;
  createdAt: string;
  source: string;
  nextReset: string;
}

const PLAN_QUOTA: Record<string, number> = { light_free: 200, medium: 3000, high: 6000 };

function Switch({ name, checked, onChange, labelledBy }: { name: string; checked: boolean; onChange: (v: boolean) => void; labelledBy: string }) {
  return (
    <div className="switch-row">
      <span className="switch-row__text" aria-hidden="true">{checked ? '啟用' : '停用'}</span>
      <button type="button" className="switch" role="switch" aria-checked={checked} aria-labelledby={labelledBy} onClick={() => onChange(!checked)} />
      <input type="hidden" name={name} value={String(checked)} />
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return <span className="field-error" id={id}>{message ?? ''}</span>;
}

export interface ProviderQuotaInfo {
  name: string;
  /** 每月請求上限；null = 沒有上限 */
  monthlyQuota: number | null;
  /** 扣掉安全緩衝後實際會用到的上限 */
  cap: number | null;
}

/** 依設定估算每月查價次數（與 lib/schedule.ts 的 estimateMonthlyCalls 相同算法） */
function estimateCalls(daily: boolean, mode: string, times: string, interval: string, skipWeekends: boolean): number {
  const days = skipWeekends ? 22 : 30;
  let extra = 0;
  if (mode === 'times') extra = times.split(/[,，、\s]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t.trim())).length;
  if (mode === 'interval') extra = Math.floor((24 * 60) / Number(interval || 15));
  return days * ((daily ? 1 : 0) + extra);
}

export function SettingsForm({
  initial,
  baseline,
  lastSaved,
  provider,
}: {
  initial: SettingsFormValues;
  baseline: BaselineInfo | null;
  lastSaved: string;
  provider: ProviderQuotaInfo;
}) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, null);
  const [resetState, resetAction, resetPending] = useActionState(resetBaselineAction, null);
  const [dailyOn, setDailyOn] = useState(initial.dailyEnabled);
  const [alertOn, setAlertOn] = useState(initial.alertEnabled);
  const [intradayMode, setIntradayMode] = useState(initial.intradayMode);
  const [checkTimes, setCheckTimes] = useState(initial.checkTimes);
  const [polling, setPolling] = useState(String(initial.pollingIntervalMinutes || 15));
  const [skipWeekends, setSkipWeekends] = useState(initial.skipWeekends);
  const [mode, setMode] = useState(initial.baselineMode);
  const [cooldown, setCooldown] = useState(String(initial.cooldownMinutes));
  const [quota, setQuota] = useState(String(initial.monthlyMessageQuota));
  const err = state?.fieldErrors ?? {};
  const invalid = (k: string) => (err[k] ? true : undefined);

  const estimate = estimateCalls(dailyOn, intradayMode, checkTimes, polling, skipWeekends);
  const overBudget = provider.cap !== null && estimate > provider.cap;

  const cooldownHint = (() => {
    const m = Number(cooldown);
    if (!Number.isFinite(m) || m <= 0) return '';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `＝ ${h ? `${h} 小時` : ''}${r ? ` ${r} 分鐘` : ''}`;
  })();

  return (
    <form
      key={lastSaved}
      className="stack"
      noValidate
      onSubmit={(e) => {
        // 手動送出：驗證失敗時保留使用者輸入，不讓 React 自動把欄位重設成舊值
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      {state ? (
        <div className={`flash ${state.ok ? 'flash--ok' : 'flash--err'}`} role="status" aria-live="polite">
          {state.message}
        </div>
      ) : null}

      <section className="card" aria-labelledby="daily-h">
        <div className="card-head">
          <div className="head-stack">
            <p className="eyebrow">01・Daily</p>
            <h2 className="card-title" id="daily-h">每日推播</h2>
          </div>
          <Switch name="dailyEnabled" checked={dailyOn} onChange={setDailyOn} labelledBy="daily-h" />
        </div>
        <fieldset className="plain-fieldset" disabled={!dailyOn}>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="dailyPushTime">推播時間（台北）</label>
            <input className="input num" type="time" id="dailyPushTime" name="dailyPushTime" defaultValue={initial.dailyPushTime} step={60} aria-invalid={invalid('dailyPushTime')} aria-describedby="dailyPushTime-error" />
            <FieldError id="dailyPushTime-error" message={err.dailyPushTime} />
          </div>
          <p className="help">
            排程服務每 15 分鐘呼叫一次，到了設定時間後的第一次呼叫才推播，所以實際時間可能晚幾分鐘。同一天最多推播一次（事件鍵 <span className="num">daily:YYYY-MM-DD</span>），排程重跑不會重複送出。
          </p>
        </fieldset>
      </section>

      <section className="card" aria-labelledby="schedule-h">
        <div className="card-head">
          <div className="head-stack">
            <p className="eyebrow">02・Schedule</p>
            <h2 className="card-title" id="schedule-h">查價時間</h2>
          </div>
        </div>
        <div className="inset" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="small" id="weekend-label">
            <b>週末（休市）不推播、不查價</b>
            <span className="cell-note">金市週六清晨到週一清晨休市，價格不會變；開啟可省下查價次數與 LINE 額度。</span>
          </span>
          <Switch name="skipWeekends" checked={skipWeekends} onChange={setSkipWeekends} labelledBy="weekend-label" />
        </div>
        <p className="help">每日推播時會查一次價；下面設定的是推播以外的盤中檢查。百分比提醒與到價提醒都在這些時間判斷。</p>
        <fieldset className="plain-fieldset" style={{ gap: 12 }}>
          <legend>盤中檢查</legend>
          <div className="radio-list">
            <label className="radio">
              <input type="radio" name="intradayMode" value="times" checked={intradayMode === 'times'} onChange={() => setIntradayMode('times')} />
              <span className="radio__title">固定時間（適合免費方案）</span>
              <span className="radio__desc">每個交易日在這些時間各查一次，多個時間用逗號分開。</span>
              <span className="radio__extra">
                <input
                  className="input num"
                  type="text"
                  name="checkTimes"
                  value={checkTimes}
                  onChange={(e) => setCheckTimes(e.target.value)}
                  placeholder="21:30"
                  aria-label="檢查時間（台北，HH:MM）"
                  aria-invalid={invalid('checkTimes')}
                  aria-describedby="checkTimes-error"
                  disabled={intradayMode !== 'times'}
                />
                <FieldError id="checkTimes-error" message={err.checkTimes} />
              </span>
            </label>
            <label className="radio">
              <input type="radio" name="intradayMode" value="interval" checked={intradayMode === 'interval'} onChange={() => setIntradayMode('interval')} />
              <span className="radio__title">固定間隔</span>
              <span className="radio__desc">全天每隔一段時間查一次，查價次數多，需要付費方案。</span>
              <span className="radio__extra">
                <select className="input" name="pollingIntervalMinutes" value={polling} onChange={(e) => setPolling(e.target.value)} aria-label="檢查間隔" disabled={intradayMode !== 'interval'}>
                  <option value="15">每 15 分鐘</option>
                  <option value="30">每 30 分鐘</option>
                  <option value="60">每 60 分鐘</option>
                </select>
              </span>
            </label>
            <label className="radio">
              <input type="radio" name="intradayMode" value="off" checked={intradayMode === 'off'} onChange={() => setIntradayMode('off')} />
              <span className="radio__title">不做盤中檢查</span>
              <span className="radio__desc">只在每日推播時查價。</span>
            </label>
          </div>
          {intradayMode !== 'interval' ? <input type="hidden" name="pollingIntervalMinutes" value={polling} /> : null}
          {intradayMode !== 'times' ? <input type="hidden" name="checkTimes" value={checkTimes} /> : null}
        </fieldset>
        <div className={`note${overBudget ? ' note--warn' : ''}`}>
          <span>
            預估每月查價約 <b className="num">{estimate}</b> 次（約 {skipWeekends ? '22 個交易日' : '30 天'} × 每天 {estimate / (skipWeekends ? 22 : 30)} 次）。
            {provider.monthlyQuota !== null
              ? overBudget
                ? ` 超過 ${provider.name} 免費額度可用的 ${provider.cap} 次；超過時系統會停止盤中檢查，但保留每日推播。`
                : ` ${provider.name} 每月上限 ${provider.monthlyQuota} 次，系統最多使用 ${provider.cap} 次（保留 ${provider.monthlyQuota - provider.cap!} 次緩衝）。`
              : ` ${provider.name} 沒有查價次數限制。`}
          </span>
        </div>
        {intradayMode === 'off' ? (
          <div className="note note--warn">
            <span>只在每日推播時查價：提醒只能依那一次的價格判斷（百分比提醒與前一交易日比較），<b>無法在價格觸及門檻的當下通知。</b></span>
          </div>
        ) : (
          <p className="help">提醒只會在查價的時間點判斷；如果價格在兩次查價之間碰到門檻又回去，會漏掉。</p>
        )}
      </section>

      <section className="card" aria-labelledby="alert-h">
        <div className="card-head">
          <div className="head-stack">
            <p className="eyebrow">03・Alerts</p>
            <h2 className="card-title" id="alert-h">價格異動提醒</h2>
          </div>
          <Switch name="alertEnabled" checked={alertOn} onChange={setAlertOn} labelledBy="alert-h" />
        </div>
        <fieldset className="plain-fieldset" disabled={!alertOn}>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="riseThresholdPercent">上漲門檻</label>
              <div className="input-affix">
                <input className="input num" type="number" id="riseThresholdPercent" name="riseThresholdPercent" defaultValue={initial.riseThresholdPercent} step="0.1" min="0.1" max="20" inputMode="decimal" aria-invalid={invalid('riseThresholdPercent')} aria-describedby="rise-error" />
                <span className="input-affix__suffix">%</span>
              </div>
              <FieldError id="rise-error" message={err.riseThresholdPercent} />
            </div>
            <div className="field">
              <label htmlFor="fallThresholdPercent">下跌門檻</label>
              <div className="input-affix">
                <input className="input num" type="number" id="fallThresholdPercent" name="fallThresholdPercent" defaultValue={initial.fallThresholdPercent} step="0.1" min="0.1" max="20" inputMode="decimal" aria-invalid={invalid('fallThresholdPercent')} aria-describedby="fall-error" />
                <span className="input-affix__suffix">%</span>
              </div>
              <FieldError id="fall-error" message={err.fallThresholdPercent} />
            </div>
            <div className="field">
              <label htmlFor="cooldownMinutes">同方向冷卻時間</label>
              <div className="input-affix">
                <input className="input num" type="number" id="cooldownMinutes" name="cooldownMinutes" value={cooldown} onChange={(e) => setCooldown(e.target.value)} step="15" min="15" max="1440" inputMode="numeric" aria-invalid={invalid('cooldownMinutes')} aria-describedby="cooldown-hint cooldown-error" />
                <span className="input-affix__suffix">分鐘</span>
              </div>
              <span className="help" id="cooldown-hint">{cooldownHint}</span>
              <FieldError id="cooldown-error" message={err.cooldownMinutes} />
            </div>
          </div>

          <fieldset className="plain-fieldset" style={{ gap: 12 }}>
            <legend>參考基準</legend>
            <div className="radio-list">
              <label className="radio">
                <input type="radio" name="baselineMode" value="first_valid_of_day" checked={mode === 'first_valid_of_day'} onChange={() => setMode('first_valid_of_day')} />
                <span className="radio__title">當日首筆有效報價（預設）</span>
                <span className="radio__desc">每個交易日第一次取得有效報價時建立，當天不會因為重新查詢而改變。</span>
              </label>
              <label className="radio">
                <input type="radio" name="baselineMode" value="previous_close" checked={mode === 'previous_close'} onChange={() => setMode('previous_close')} />
                <span className="radio__title">前一交易日參考價</span>
                <span className="radio__desc">使用前一個有效交易日的每日快照價格。</span>
              </label>
              <label className="radio">
                <input type="radio" name="baselineMode" value="manual" checked={mode === 'manual'} onChange={() => setMode('manual')} />
                <span className="radio__title">手動指定</span>
                <span className="radio__desc">固定使用你輸入的價格，直到再次修改。</span>
                <span className="radio__extra">
                  <span className="input-affix">
                    <input className="input num" type="number" name="manualBaselinePrice" defaultValue={initial.manualBaselinePrice} step="0.01" min="0.01" inputMode="decimal" aria-label="手動基準價格" aria-invalid={invalid('manualBaselinePrice')} aria-describedby="manual-error" disabled={mode !== 'manual'} />
                  </span>
                  <FieldError id="manual-error" message={err.manualBaselinePrice} />
                </span>
              </label>
            </div>
            <div className="inset" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {baseline ? (
                <dl className="kv-list">
                  <dt>目前基準</dt><dd><span className="num">{baseline.price}</span> {baseline.unit}</dd>
                  <dt>建立時間</dt><dd className="num">{baseline.createdAt}</dd>
                  <dt>來源</dt><dd>{baseline.source}</dd>
                  <dt>下次重設</dt><dd>{baseline.nextReset}</dd>
                </dl>
              ) : (
                <p className="small soft">今天還沒有基準價，下一筆有效報價會依規則建立。</p>
              )}
              {mode !== 'manual' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={resetPending}
                    onClick={() => startTransition(() => resetAction())}
                  >
                    {resetPending ? '處理中…' : '立即重設基準'}
                  </button>
                  <span className="help">今天改用最新一筆有效報價作為基準。</span>
                  <span className="small" role="status" aria-live="polite" style={resetState && !resetState.ok ? { color: 'var(--err)' } : undefined}>
                    {resetState?.message ?? ''}
                  </span>
                </div>
              ) : null}
            </div>
          </fieldset>
        </fieldset>
      </section>

      <section className="card" aria-labelledby="quota-h">
        <div className="card-head" style={{ alignItems: 'flex-end' }}>
          <div className="head-stack">
            <p className="eyebrow">04・Quota</p>
            <h2 className="card-title" id="quota-h">LINE 訊息額度</h2>
          </div>
          <a className="lnk" href="/status#quota">查看本月用量 →</a>
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="linePlan">LINE 方案</label>
            <select
              className="input"
              id="linePlan"
              name="linePlan"
              defaultValue={initial.linePlan}
              onChange={(e) => {
                const q = PLAN_QUOTA[e.target.value];
                if (q) setQuota(String(q));
              }}
            >
              <option value="light_free">輕用量（免費，每月 200 則）</option>
              <option value="medium">中用量（每月 3,000 則）</option>
              <option value="high">高用量（每月 6,000 則）</option>
              <option value="other">其他方案</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="monthlyMessageQuota">每月訊息額度</label>
            <div className="input-affix">
              <input className="input num" type="number" id="monthlyMessageQuota" name="monthlyMessageQuota" value={quota} onChange={(e) => setQuota(e.target.value)} step="1" min="1" inputMode="numeric" aria-invalid={invalid('monthlyMessageQuota')} aria-describedby="quota-help quota-error" />
              <span className="input-affix__suffix">則</span>
            </div>
            <span className="help" id="quota-help">依 LINE 當期方案填寫，系統會再用官方用量核對。</span>
            <FieldError id="quota-error" message={err.monthlyMessageQuota} />
          </div>
          <div className="field">
            <label htmlFor="quotaSafetyBuffer">安全緩衝</label>
            <div className="input-affix">
              <input className="input num" type="number" id="quotaSafetyBuffer" name="quotaSafetyBuffer" defaultValue={initial.quotaSafetyBuffer} step="1" min="0" max="100" inputMode="numeric" aria-invalid={invalid('quotaSafetyBuffer')} aria-describedby="buffer-error" />
              <span className="input-affix__suffix">則</span>
            </div>
            <FieldError id="buffer-error" message={err.quotaSafetyBuffer} />
          </div>
        </div>
        <ul className="rules">
          <li>每日推播優先：保留額度 ＝ 本月剩餘天數 × 推播人數 ＋ 安全緩衝（LINE 每送給 1 人算 1 則）。</li>
          <li>剩餘額度低於保留額度時，暫停異動提醒與測試推播，並在系統狀態頁顯示原因。</li>
          <li>查不到 LINE 官方用量時視為額度不足，不假設還有免費額度。</li>
          <li>月份依 LINE 計費規則以日本時間切換（台灣時間月底 23:00 之後算下個月）。</li>
          <li>不會自動升級方案，也不會加購訊息。</li>
        </ul>
      </section>

      <div className="card card--tight" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="small soft">上次儲存 <span className="num">{lastSaved}</span></span>
        <div className="btn-row">
          <button type="reset" className="btn" onClick={() => { setDailyOn(initial.dailyEnabled); setAlertOn(initial.alertEnabled); setIntradayMode(initial.intradayMode); setCheckTimes(initial.checkTimes); setSkipWeekends(initial.skipWeekends); setPolling(String(initial.pollingIntervalMinutes || 15)); setMode(initial.baselineMode); setCooldown(String(initial.cooldownMinutes)); setQuota(String(initial.monthlyMessageQuota)); }}>
            還原變更
          </button>
          <button type="submit" className="btn btn--primary" disabled={pending}>{pending ? '儲存中…' : '儲存設定'}</button>
        </div>
      </div>
    </form>
  );
}
