import { describe, expect, it } from 'vitest';
import { computeChange } from '../gold/math';
import { formatChangeLine } from '../line/messages';
import {
  buildChartLabels,
  buildChartModel,
  CHART_FILE_PATTERN,
  CHART_GLYPHS,
  chartImageUrl,
  niceStep,
  resolveAppUrl,
  type ChartInfo,
  type ChartPoint,
} from './daily-chart';

// 走勢圖：座標、刻度、圖上文字與網址規則。

const series = (prices: number[]): ChartPoint[] =>
  prices.map((price, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, price }));

describe('走勢圖座標', () => {
  it('少於 2 個有效點時不畫圖', () => {
    expect(buildChartModel([], 800, 300)).toBeNull();
    expect(buildChartModel(series([4100]), 800, 300)).toBeNull();
    expect(buildChartModel(series([4100, Number.NaN, 0]), 800, 300)).toBeNull();
  });

  it('點由左到右鋪滿寬度，價格越高越靠上，都在繪圖區內', () => {
    const m = buildChartModel(series([4100, 4180, 4050, 4161.51]), 800, 300)!;
    expect(m.points.map((p) => p.x)).toEqual([0, 266.7, 533.3, 800]);
    for (const p of m.points) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(300);
    }
    expect(m.high.price).toBe(4180);
    expect(m.low.price).toBe(4050);
    expect(m.high.y).toBeLessThan(m.low.y);
    expect(m.last.price).toBe(4161.51);
    expect(m.line.startsWith('M0 ')).toBe(true);
    // 左右留白讓端點的圓點不被裁掉
    const inset = buildChartModel(series([4100, 4180, 4050, 4161.51]), 800, 300, 12)!;
    expect([inset.first.x, inset.last.x]).toEqual([12, 788]);
    expect(m.area.endsWith('Z')).toBe(true);
  });

  it('刻度間距是好讀的整數，涵蓋最高與最低價', () => {
    expect([niceStep(23), niceStep(40), niceStep(0.7), niceStep(180)]).toEqual([25, 50, 1, 200]);
    const m = buildChartModel(series([4100, 4180, 4050, 4161.51]), 800, 300)!;
    const values = m.ticks.map((t) => t.value);
    expect(values[0]).toBeLessThanOrEqual(4050);
    expect(values.at(-1)).toBeGreaterThanOrEqual(4180);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('全部同價時也畫得出來（不會除以零）', () => {
    const m = buildChartModel(series([4000, 4000, 4000]), 800, 300)!;
    expect(m.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('X 軸標第一天、中間與最後一天', () => {
    const m = buildChartModel(series([1, 2, 3, 4, 5, 6, 7].map((n) => 4000 + n)), 800, 300)!;
    expect(m.xLabels.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-04', '2026-10-07']);
  });
});

describe('走勢圖文字', () => {
  const info: ChartInfo = { source: 'goldapi', symbol: 'XAUUSD', currency: 'USD', unit: 'troy_oz', status: 'valid', date: '2026-10-14' };
  const model = buildChartModel(series([4100, 4182.45, 4161.51]), 800, 300)!;

  it('漲跌取最後兩個交易日，跟每日訊息用同一套箭頭', () => {
    const l = buildChartLabels(model, info);
    expect(l.title).toBe('國際現貨黃金・近 3 個交易日');
    expect(l.price).toBe('4,161.51');
    expect(l.unit).toBe('USD / 金衡盎司');
    expect(l.change).toBe('▼ −20.94（−0.50%）');
    expect(l.tone).toBe('down');
    expect(l.date).toBe('2026/10/14（三）');
    expect(l.source).toBe('資料來源：GoldAPI.io・每日快照・台灣時間');
  });

  it('漲跌金額跟每日訊息一致（2026-10-14 真實數字：4161.505 對 4182.45）', () => {
    // 直接相減是 −20.94499…，會顯示成 −20.94；訊息用 computeChange 是 −20.95，兩邊要一樣
    const real = buildChartModel(series([4182.45, 4161.505]), 800, 300)!;
    const change = computeChange(4161.505, 4182.45)!;
    expect(buildChartLabels(real, info).change).toBe('▼ −20.95（−0.50%）');
    expect(formatChangeLine(change.amount, change.percent, 'USD')).toBe('▼ −20.95 USD（−0.50%）');
  });

  it('模擬資料在圖上也會標示', () => {
    const l = buildChartLabels(model, { ...info, source: 'mock', status: 'mock' });
    expect(l.title).toContain('模擬資料');
    expect(l.source).toContain('Mock Provider（模擬資料）');
  });

  it('圖上用到的字都在字型子集裡（否則會變成方塊）', () => {
    const allowed = new Set([...CHART_GLYPHS, ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i))]);
    const variants: ChartInfo[] = [
      info,
      { ...info, source: 'mock', status: 'mock' },
      { ...info, unit: 'gram', status: 'delayed' },
    ];
    const flat = buildChartModel(series([4000, 4000]), 800, 300)!;
    const up = buildChartModel(series([4000, 4100]), 800, 300)!;
    for (const m of [model, flat, up]) {
      for (const v of variants) {
        const l = buildChartLabels(m, v);
        const text = [l.title, l.price, l.unit, l.change, l.date, l.high, l.low, l.source, ...l.ticks, ...l.xLabels, '較前一交易日', 'Gold Daily'].join('');
        const missing = [...text].filter((c) => !allowed.has(c));
        expect(missing).toEqual([]);
      }
    }
  });
});

describe('走勢圖網址', () => {
  it('優先用 NEXT_PUBLIC_APP_URL，沒有時用 Vercel 的正式網域', () => {
    expect(resolveAppUrl({ NEXT_PUBLIC_APP_URL: 'https://gold.example/some/path', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://gold.example');
    expect(resolveAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'gold-daily-pearl.vercel.app' })).toBe('https://gold-daily-pearl.vercel.app');
    expect(resolveAppUrl({})).toBeNull();
    expect(resolveAppUrl({ NEXT_PUBLIC_APP_URL: 'not a url' })).toBeNull();
  });

  it('LINE 只接受 https，本機 http 不附圖', () => {
    expect(chartImageUrl('https://gold.example', '2026-10-14')).toBe('https://gold.example/api/chart/2026-10-14.png');
    expect(chartImageUrl('http://localhost:3000', '2026-10-14')).toBeNull();
    expect(chartImageUrl(null, '2026-10-14')).toBeNull();
  });

  it('只接受 YYYY-MM-DD.png', () => {
    expect(CHART_FILE_PATTERN.exec('2026-10-14.png')?.[1]).toBe('2026-10-14');
    for (const bad of ['2026-10-14', '2026-10-14.jpg', '../2026-10-14.png', '2026-1-4.png', 'x2026-10-14.png']) {
      expect(CHART_FILE_PATTERN.test(bad)).toBe(false);
    }
  });
});
