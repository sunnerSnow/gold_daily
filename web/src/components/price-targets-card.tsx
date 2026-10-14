'use client';

import { startTransition, useActionState, useState } from 'react';
import { addTargetAction, cancelTargetAction, rearmTargetAction } from '@/app/actions';
import { ActionButton } from './action-button';

// 到價提醒：價格漲到（或跌到）目標價時送一則 LINE，送出後自動關閉。

export interface TargetView {
  id: number;
  direction: 'above' | 'below';
  targetPrice: number;
  note: string | null;
  status: 'active' | 'triggered' | 'cancelled';
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
  eventLabel: string | null;
}

const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (target: number, current: number) => {
  const p = ((target - current) / current) * 100;
  return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p).toFixed(2)}%`;
};

export function PriceTargetsCard({
  active,
  history,
  currentPrice,
  unitLabel,
  isMock,
  checkSummary,
}: {
  active: TargetView[];
  history: TargetView[];
  currentPrice: number | null;
  unitLabel: string;
  isMock: boolean;
  checkSummary: string;
}) {
  const [state, formAction, pending] = useActionState(addTargetAction, null);
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  const err = state?.fieldErrors ?? {};
  const typed = Number(price);
  const preview =
    currentPrice && Number.isFinite(typed) && typed > 0
      ? (direction === 'above' ? typed <= currentPrice : typed >= currentPrice)
        ? '目前價格已經達到這個目標，下一次查價就會觸發。'
        : `距離目前價格 ${pct(typed, currentPrice)}。`
      : '';

  return (
    <section className="card" aria-labelledby="targets-h">
      <div className="card-head" style={{ alignItems: 'flex-end' }}>
        <div className="head-stack">
          <p className="eyebrow">05・Targets</p>
          <div className="card-head__title">
            <h2 className="card-title" id="targets-h">到價提醒</h2>
            {isMock ? <span className="chip chip--mock">模擬資料</span> : null}
          </div>
        </div>
        {currentPrice ? (
          <span className="small soft">
            目前 <span className="num">{fmt(currentPrice)}</span> {unitLabel}
          </span>
        ) : null}
      </div>
      <p className="help">
        價格漲到（或跌到）目標價時送一則 LINE，送出後這個目標價自動關閉。{checkSummary}
      </p>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(async () => {
            formAction(data);
          });
        }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 14px' }}
      >
        <div className="field" style={{ flex: '1 1 150px' }}>
          <label htmlFor="target-direction">條件</label>
          <select className="input" id="target-direction" name="direction" value={direction} onChange={(e) => setDirection(e.target.value as 'above' | 'below')}>
            <option value="above">漲到以上</option>
            <option value="below">跌到以下</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 170px' }}>
          <label htmlFor="target-price">目標價（{unitLabel}）</label>
          <input
            className="input num"
            type="number"
            id="target-price"
            name="targetPrice"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            step="0.01"
            min="0.01"
            inputMode="decimal"
            aria-invalid={err.targetPrice ? true : undefined}
            aria-describedby="target-price-hint target-price-error"
          />
        </div>
        <div className="field" style={{ flex: '2 1 200px' }}>
          <label htmlFor="target-note">備註（選填）</label>
          <input className="input" type="text" id="target-note" name="note" maxLength={40} placeholder="例如：考慮賣出" />
        </div>
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? '新增中…' : '新增到價提醒'}
        </button>
      </form>
      <span className="help" id="target-price-hint">{preview}</span>
      <span className="field-error" id="target-price-error">{err.targetPrice ?? err.direction ?? err.note ?? ''}</span>
      {state ? (
        <div className={`flash ${state.ok ? 'flash--ok' : 'flash--err'}`} role="status" aria-live="polite">
          {state.message}
        </div>
      ) : null}

      <div className="divider">
        <h3 style={{ fontSize: 14.5, fontWeight: 700 }}>啟用中（{active.length}）</h3>
        {active.length === 0 ? (
          <p className="small soft" style={{ marginTop: 6 }}>目前沒有到價提醒。</p>
        ) : (
          <ul className="target-list">
            {active.map((t) => (
              <li key={t.id}>
                <div>
                  <span className={t.direction === 'above' ? 'up' : 'down'}>{t.direction === 'above' ? '▲ 漲到' : '▼ 跌到'}</span>{' '}
                  <span className="target-list__price">{fmt(t.targetPrice)}</span> {t.direction === 'above' ? '以上' : '以下'}
                  <span className="cell-note">
                    {t.note ? `${t.note}・` : ''}
                    建立於 {t.createdAt}
                    {currentPrice ? `・距離 ${pct(t.targetPrice, currentPrice)}` : ''}
                  </span>
                </div>
                <ActionButton action={cancelTargetAction} fields={{ targetId: String(t.id) }} label="取消" variant="small" />
              </li>
            ))}
          </ul>
        )}
      </div>

      {history.length > 0 ? (
        <div className="divider">
          <h3 style={{ fontSize: 14.5, fontWeight: 700 }}>最近觸發或取消</h3>
          <ul className="target-list">
            {history.map((t) => (
              <li key={t.id}>
                <div>
                  <span className={`chip ${t.status === 'triggered' ? 'chip--ok' : 'chip--muted'}`}>{t.status === 'triggered' ? '已觸發' : '已取消'}</span>{' '}
                  {t.direction === 'above' ? '漲到' : '跌到'} <span className="num">{fmt(t.targetPrice)}</span> {t.direction === 'above' ? '以上' : '以下'}
                  <span className="cell-note">
                    {t.status === 'triggered' && t.triggeredAt
                      ? `${t.triggeredAt} 觸發，當時價格 ${t.triggeredPrice !== null ? fmt(t.triggeredPrice) : '—'}${t.eventLabel ? `・${t.eventLabel}` : ''}`
                      : `建立於 ${t.createdAt}`}
                  </span>
                </div>
                <ActionButton action={rearmTargetAction} fields={{ targetId: String(t.id) }} label="重新啟用" variant="small" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
