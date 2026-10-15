import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { buildChartLabels, buildChartModel, CHART_FILE_PATTERN, CHART_HEIGHT, CHART_WIDTH } from '@/lib/chart/daily-chart';
import { loadChartSnapshots } from '@/lib/jobs/chart-data';
import { buildDeps } from '@/lib/server';

// 每日推播附的走勢圖：/api/chart/2026-10-14.png
// LINE 的伺服器要能直接抓，所以不需要登入；內容只有公開的金價，而且只畫資料庫裡已有的每日快照。
// 同一天的圖內容固定，交給 Vercel CDN 快取；網址格式不對或那天沒資料一律 404 且不快取。

export const dynamic = 'force-dynamic';

const PAD_X = 48;
// 手機上點開約縮成 390pt 寬（約 0.38 倍），字級要夠大才讀得到
const LABEL_COL = 92;
const PLOT_W = CHART_WIDTH - PAD_X * 2 - LABEL_COL;
const PLOT_H = 262;

const COLOR = {
  bg: '#FFFCF7',
  ink: '#222222',
  ink2: '#4D4D4D',
  ink3: '#666666',
  grid: '#EFE5D8',
  line: '#9C7012',
  area: '#C9971E',
  up: '#B42F3A',
  down: '#3B5E1F',
  accentA: '#EDBF62',
  accentB: '#F3D69B',
};

let fonts: Promise<Buffer[]> | null = null;
function loadFonts() {
  fonts ??= Promise.all(
    ['NotoSansTC-Medium-chart.ttf', 'NotoSansTC-Bold-chart.ttf'].map((f) => readFile(join(process.cwd(), 'src/assets/fonts', f))),
  );
  return fonts;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const date = CHART_FILE_PATTERN.exec(file)?.[1];
  // 帶查詢字串的網址會繞過 CDN 快取，一律拒絕
  if (!date || new URL(request.url).search) return notFound();

  try {
    const deps = await buildDeps();
    const data = await loadChartSnapshots(deps, date);
    if (!data) return notFound();
    const model = buildChartModel(
      data.rows.map((r) => ({ date: r.dailyDate!, price: r.price })),
      PLOT_W,
      PLOT_H,
      12,
    );
    if (!model) return notFound();
    const last = data.rows[data.rows.length - 1];
    const labels = buildChartLabels(model, { ...data.instrument, status: last.status, date });
    const [medium, bold] = await loadFonts();
    const toneColor = labels.tone === 'up' ? COLOR.up : labels.tone === 'down' ? COLOR.down : COLOR.ink2;

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: COLOR.bg,
            color: COLOR.ink,
            fontFamily: 'Noto Sans TC',
            padding: `44px ${PAD_X}px 30px`,
            position: 'relative',
          }}
        >
          <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 10, display: 'flex', backgroundImage: `linear-gradient(90deg, ${COLOR.accentA}, ${COLOR.accentB})` }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 27, fontWeight: 500, color: COLOR.ink2 }}>{labels.title}</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 6 }}>
                <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1 }}>{labels.price}</div>
                <div style={{ fontSize: 26, fontWeight: 500, color: COLOR.ink2, marginLeft: 12, marginBottom: 8 }}>{labels.unit}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 12 }}>
                <div style={{ fontSize: 31, fontWeight: 700, color: toneColor }}>{labels.change}</div>
                <div style={{ fontSize: 24, fontWeight: 500, color: COLOR.ink3, marginLeft: 12 }}>較前一交易日</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div style={{ fontSize: 27, fontWeight: 500, color: COLOR.ink2 }}>{labels.date}</div>
              <div style={{ fontSize: 24, fontWeight: 500, color: COLOR.ink3, marginTop: 16 }}>{labels.high}</div>
              <div style={{ fontSize: 24, fontWeight: 500, color: COLOR.ink3, marginTop: 4 }}>{labels.low}</div>
            </div>
          </div>

          <div style={{ display: 'flex', position: 'relative', width: PLOT_W + LABEL_COL, height: PLOT_H + 40, marginTop: 22 }}>
            <svg width={PLOT_W} height={PLOT_H} viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} style={{ position: 'absolute', left: 0, top: 0 }}>
              <defs>
                <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLOR.area} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={COLOR.area} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {model.ticks.map((t) => (
                <line key={t.value} x1={0} y1={t.y} x2={PLOT_W} y2={t.y} stroke={COLOR.grid} strokeWidth={1} />
              ))}
              <path d={model.area} fill="url(#fill)" />
              <path d={model.line} fill="none" stroke={COLOR.line} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={model.last.x} cy={model.last.y} r={8} fill={COLOR.line} stroke={COLOR.bg} strokeWidth={3} />
            </svg>
            {model.ticks.map((t, i) => (
              <div key={t.value} style={{ position: 'absolute', left: PLOT_W + 12, top: t.y - 16, fontSize: 22, fontWeight: 500, color: COLOR.ink3 }}>
                {labels.ticks[i]}
              </div>
            ))}
            {model.xLabels.map((p, i) => {
              const edge = i === 0 ? 'left' : i === model.xLabels.length - 1 ? 'right' : 'center';
              const left = edge === 'left' ? 0 : edge === 'right' ? p.x - 80 : p.x - 40;
              return (
                <div
                  key={p.date}
                  style={{ position: 'absolute', top: PLOT_H + 8, left, width: 80, display: 'flex', justifyContent: edge === 'left' ? 'flex-start' : edge === 'right' ? 'flex-end' : 'center', fontSize: 22, fontWeight: 500, color: COLOR.ink3 }}
                >
                  {labels.xLabels[i]}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', fontSize: 21, fontWeight: 500, color: COLOR.ink3 }}>
            <div>{labels.source}</div>
            <div style={{ fontWeight: 700, color: COLOR.ink2 }}>Gold Daily</div>
          </div>
        </div>
      ),
      {
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        fonts: [
          { name: 'Noto Sans TC', data: medium, weight: 500, style: 'normal' },
          { name: 'Noto Sans TC', data: bold, weight: 700, style: 'normal' },
        ],
        headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400' },
      },
    );
  } catch (err) {
    console.error('chart render failed', err instanceof Error ? err.message : err);
    return new Response('Chart unavailable', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
