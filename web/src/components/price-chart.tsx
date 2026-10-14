'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChartPoint } from '@/lib/view/dashboard';

// 價格走勢：只畫資料庫裡的每日快照，缺漏日不補值；沒有資料時顯示空狀態。
// 單一數列，標題就是圖例；滑鼠或方向鍵逐日查看。

const RANGES = [7, 30, 90] as const;
const WEEKDAYS = '日一二三四五六';

const fmt = (v: number, dp = 2) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (v: number, dp = 2) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), dp);
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const label = (iso: string) => `${iso.replaceAll('-', '/')}（${WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]}）`;

function niceStep(raw: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

export function PriceChart({ points, today, isMock }: { points: ChartPoint[]; today: string; isMock: boolean }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  // 用 callback ref：圖表在空狀態與有資料之間切換時也能重新量寬度
  const [host, setHost] = useState<HTMLElement | null>(null);
  const H = 280;

  useEffect(() => {
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);

  const { pts, offset } = useMemo(() => {
    const cut = new Date(`${today}T00:00:00Z`);
    cut.setUTCDate(cut.getUTCDate() - range);
    const cutIso = cut.toISOString().slice(0, 10);
    const start = points.findIndex((p) => p.date >= cutIso);
    return start === -1 ? { pts: [], offset: points.length } : { pts: points.slice(start), offset: start };
  }, [points, range, today]);

  const stats = useMemo(() => {
    if (pts.length === 0) return null;
    const vals = pts.map((p) => p.price);
    const delta = pts[pts.length - 1].price - pts[0].price;
    return { hi: Math.max(...vals), lo: Math.min(...vals), delta, pct: (delta / pts[0].price) * 100 };
  }, [pts]);

  const geo = useMemo(() => {
    if (pts.length === 0 || width === 0) return null;
    const padL = 60, padR = 12, padT = 12, padB = 30;
    const vals = pts.map((p) => p.price);
    const min = Math.min(...vals), max = Math.max(...vals);
    const step = niceStep((max - min) / 4 || 10);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step || lo + step;
    const iw = width - padL - padR, ih = H - padT - padB;
    const x = (i: number) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
    const y = (v: number) => padT + ((hi - v) / (hi - lo || 1)) * ih;
    const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step);
    const nx = Math.min(5, pts.length);
    const xIdx = [...new Set(Array.from({ length: nx }, (_, k) => Math.round((k * (pts.length - 1)) / (nx - 1 || 1))))];
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');
    const base = padT + ih;
    return { padL, padR, padT, iw, ih, x, y, ticks, xIdx, line, base };
  }, [pts, width]);

  const show = active !== null && geo && pts[active] ? active : null;
  const prevOf = (i: number) => (offset + i > 0 ? points[offset + i - 1] : null);

  return (
    <section className="card" style={{ gap: 20 }} aria-labelledby="chart-h">
      <div className="card-head" style={{ alignItems: 'flex-end' }}>
        <div className="head-stack">
          <p className="eyebrow">Trend</p>
          <div className="card-head__title">
            <h2 className="card-title" id="chart-h">價格走勢</h2>
            {isMock ? <span className="chip chip--mock">模擬資料</span> : null}
          </div>
        </div>
        <div className="seg" role="group" aria-label="走勢區間">
          {RANGES.map((r) => (
            <button key={r} type="button" className="seg__btn" aria-pressed={range === r} onClick={() => { setRange(r); setActive(null); }} disabled={points.length === 0}>
              {r} 天
            </button>
          ))}
        </div>
      </div>

      {stats ? (
        <dl className="stats">
          <div><dt>區間最高</dt><dd className="num">{fmt(stats.hi)}</dd></div>
          <div><dt>區間最低</dt><dd className="num">{fmt(stats.lo)}</dd></div>
          <div><dt>區間漲跌</dt><dd className={`num ${stats.delta >= 0 ? 'up' : 'down'}`}>{signed(stats.delta)}（{signed(stats.pct)}%）</dd></div>
          <div><dt>資料點</dt><dd><span className="num">{pts.length}</span> 筆每日快照</dd></div>
        </dl>
      ) : null}

      {pts.length === 0 ? (
        <div className="empty" style={{ padding: '64px 20px' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></svg>
          <span className="empty__title">{points.length === 0 ? '尚無歷史資料' : `近 ${range} 天沒有每日快照`}</span>
          <span className="empty__text">每日快照寫入後，這裡會顯示近 7／30／90 天走勢。不會用模擬或推估的數值補圖。</span>
        </div>
      ) : (
        <figure className="chart" ref={setHost}>
          <svg
            role="img"
            tabIndex={0}
            style={{ height: H }}
            aria-label={`近 ${range} 天每日快照走勢${isMock ? '（模擬資料）' : ''}，${md(pts[0].date)} ${fmt(pts[0].price)} 至 ${md(pts[pts.length - 1].date)} ${fmt(pts[pts.length - 1].price)}。可用左右方向鍵逐日查看。`}
            onPointerMove={(e) => {
              if (!geo) return;
              const r = e.currentTarget.getBoundingClientRect();
              const i = Math.round(((e.clientX - r.left - geo.padL) / geo.iw) * (pts.length - 1));
              setActive(Math.max(0, Math.min(pts.length - 1, i)));
            }}
            onPointerLeave={(e) => { if (document.activeElement !== e.currentTarget) setActive(null); }}
            onFocus={() => setActive((a) => a ?? pts.length - 1)}
            onBlur={() => setActive(null)}
            onKeyDown={(e) => {
              const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
              if (e.key in map) { e.preventDefault(); setActive((a) => Math.max(0, Math.min(pts.length - 1, (a ?? pts.length - 1) + map[e.key]))); }
              if (e.key === 'Home') { e.preventDefault(); setActive(0); }
              if (e.key === 'End') { e.preventDefault(); setActive(pts.length - 1); }
            }}
          >
            {geo ? (
              <>
                {geo.ticks.map((v, k) => (
                  <g key={v}>
                    <line className={k === 0 ? 'axis' : 'grid'} x1={geo.padL} x2={width - geo.padR} y1={geo.y(v)} y2={geo.y(v)} />
                    <text x={geo.padL - 10} y={geo.y(v)} textAnchor="end" dominantBaseline="middle">{fmt(v, 0)}</text>
                  </g>
                ))}
                {geo.xIdx.map((i, k) => (
                  <text key={i} x={geo.x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}>{md(pts[i].date)}</text>
                ))}
                <path className="area" d={`${geo.line} L${geo.x(pts.length - 1).toFixed(1)} ${geo.base} L${geo.x(0).toFixed(1)} ${geo.base} Z`} />
                <path className="line" d={geo.line} />
                <circle className="last" cx={geo.x(pts.length - 1)} cy={geo.y(pts[pts.length - 1].price)} r={5} />
                {show !== null ? (
                  <>
                    <line className="cross" x1={geo.x(show)} x2={geo.x(show)} y1={geo.padT} y2={geo.base} />
                    <circle className="hover-dot" cx={geo.x(show)} cy={geo.y(pts[show].price)} r={5} />
                  </>
                ) : null}
                <rect x={geo.padL} y={geo.padT} width={Math.max(geo.iw, 0)} height={Math.max(geo.ih, 0)} fill="transparent" />
              </>
            ) : null}
          </svg>
          {show !== null && geo ? (
            <Tip
              left={Math.max(80, Math.min(width - 80, geo.x(show)))}
              top={geo.y(pts[show].price)}
              point={pts[show]}
              prev={prevOf(show)}
            />
          ) : null}
        </figure>
      )}
      <p className="visually-hidden" aria-live="polite">
        {show !== null ? `${label(pts[show].date)} ${fmt(pts[show].price)}` : ''}
      </p>
      <p className="caption">
        資料取自 gold_price_snapshots 的每日快照{isMock ? '（Mock Provider）' : ''}。只畫已寫入的有效快照，缺漏日不補值。逐筆數字見<a href="/history">歷史資料</a>。
      </p>
    </section>
  );
}

function Tip({ left, top, point, prev }: { left: number; top: number; point: ChartPoint; prev: ChartPoint | null }) {
  const c = prev ? point.price - prev.price : null;
  return (
    <div className="chart__tip" style={{ left, top, transform: top < 80 ? 'translate(-50%, 14px)' : undefined }}>
      <span>{label(point.date)}</span>
      <b>{fmt(point.price)}</b>
      {c === null || !prev ? (
        <span>資料中第一筆，無參考價</span>
      ) : (
        <span className={c >= 0 ? 'tip-up' : 'tip-down'}>
          {c >= 0 ? '▲ ' : '▼ '}
          {signed(c)}（{signed((c / prev.price) * 100)}%）
        </span>
      )}
    </div>
  );
}
