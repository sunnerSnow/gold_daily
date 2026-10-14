'use client';

import { useState } from 'react';

// 行情跑馬燈：可暫停（WCAG 2.2.2）；系統設定減少動態效果時 CSS 會停用動畫。

export interface TickerItem {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}

export function Ticker({ items, label }: { items: TickerItem[]; label: string }) {
  const [paused, setPaused] = useState(false);
  const group = (hidden: boolean) => (
    <div className="ticker__group" aria-hidden={hidden || undefined}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="ticker__item">
            <b>{it.label}</b>
            <span className={`num ${it.tone ?? ''}`}>{it.value}</span>
          </span>
          <span className="ticker__sep" aria-hidden="true">◆</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className={`ticker${paused ? ' is-paused' : ''}`} role="region" aria-label={label}>
      <div className="ticker__viewport">
        <div className="ticker__track">
          {group(false)}
          {group(true)}
        </div>
      </div>
      <button type="button" className="ticker__toggle" aria-pressed={paused} aria-label={paused ? '播放跑馬燈' : '暫停跑馬燈'} onClick={() => setPaused((p) => !p)}>
        <svg className="i-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        <svg className="i-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
      </button>
    </div>
  );
}
