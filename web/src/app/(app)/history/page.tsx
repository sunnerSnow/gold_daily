import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHead } from '@/components/site-chrome';
import { formatPercent, formatPrice, formatSigned } from '@/lib/gold/math';
import { UNIT_LABEL } from '@/lib/gold/types';
import { buildDeps } from '@/lib/server';
import { formatDateLabel, formatTaipei } from '@/lib/time';
import { loadHistory, parseHistoryQuery, type HistoryQuery } from '@/lib/view/history';

export const metadata: Metadata = { title: '歷史資料' };
export const dynamic = 'force-dynamic';

function href(q: HistoryQuery, page: number) {
  const p = new URLSearchParams({ from: q.from, to: q.to, status: q.filter, page: String(page) });
  return `/history?${p.toString()}`;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const deps = await buildDeps();
  const q = parseHistoryQuery(await searchParams, deps.now());
  const data = await loadHistory(deps, q);
  const inst = data.provider.instrument;

  return (
    <>
      <div className="on-gold">
        <PageHead
          eyebrow="History"
          title="歷史資料"
          description={`每日快照・價格單位 ${inst ? `${inst.currency} / ${UNIT_LABEL[inst.unit]}` : '—'}・時間為台北時間`}
        >
          {data.provider.isMock ? <span className="chip chip--mock">模擬資料</span> : null}
        </PageHead>
      </div>

      <main className="page" style={{ gap: 20 }}>
        <section className="card" style={{ padding: '20px 24px' }} aria-label="篩選條件">
          <form method="get" action="/history" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '14px 18px' }}>
            <div className="field" style={{ flex: '1 1 170px' }}>
              <label htmlFor="f-from">起始日期</label>
              <input className="input num" type="date" id="f-from" name="from" defaultValue={q.from} max={q.to} />
            </div>
            <div className="field" style={{ flex: '1 1 170px' }}>
              <label htmlFor="f-to">結束日期</label>
              <input className="input num" type="date" id="f-to" name="to" defaultValue={q.to} />
            </div>
            <div className="field" style={{ flex: '1 1 190px' }}>
              <label htmlFor="f-status">資料狀態</label>
              <select className="input" id="f-status" name="status" defaultValue={q.filter}>
                <option value="all">全部</option>
                <option value="valid">有效</option>
                <option value="missing">未取得有效報價</option>
                <option value="noref">無參考價</option>
              </select>
            </div>
            <input type="hidden" name="page" value="1" />
            <div className="btn-row">
              <button type="submit" className="btn btn--primary">套用</button>
              <Link className="btn" href="/history" style={{ textDecoration: 'none' }}>清除篩選</Link>
            </div>
          </form>
        </section>

        <section className="card" style={{ padding: '24px 28px 14px', gap: 10 }} aria-labelledby="tbl-h">
          <div className="card-head" style={{ alignItems: 'flex-end' }}>
            <div className="head-stack">
              <p className="eyebrow">Daily snapshots</p>
              <h2 className="card-title" id="tbl-h">每日快照</h2>
            </div>
            <p className="small soft">
              共 <span className="num">{data.total}</span> 筆・漲跌以前一個有效交易日為基準
            </p>
          </div>

          {data.rows.length === 0 ? (
            <div className="empty" style={{ margin: '8px 0 16px' }}>
              <span className="empty__title">{data.total === 0 && q.filter === 'all' ? '尚無歷史資料' : '這個條件下沒有快照'}</span>
              <span className="empty__text">{data.provider.configured ? '每日排程寫入快照後會出現在這裡；不會用推估的數值補資料。' : '尚未設定行情來源。'}</span>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl--history">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th className="r">黃金價格</th>
                    <th className="r">漲跌金額</th>
                    <th className="r">漲跌幅</th>
                    <th>資料來源</th>
                    <th>報價時間</th>
                    <th>資料狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const tone = r.changeAmount === null ? 'soft' : r.changeAmount >= 0 ? 'up' : 'down';
                    return (
                      <tr key={`${r.kind}-${r.date}`} className={r.kind === 'missing' ? 'is-gap' : undefined}>
                        <td className="num nowrap">{formatDateLabel(r.date)}</td>
                        <td className="num r">{formatPrice(r.price)}</td>
                        <td className={`num r ${tone}`}>{formatSigned(r.changeAmount)}</td>
                        <td className={`num r ${tone}`}>{formatPercent(r.changePercent)}</td>
                        <td>{r.source}</td>
                        <td className="num soft nowrap">{r.quoteTimestamp ? formatTaipei(r.quoteTimestamp).slice(5) : '來源未更新'}</td>
                        <td>
                          {r.kind === 'missing' ? (
                            <span className="chip chip--err">未取得有效報價</span>
                          ) : r.kind === 'noref' ? (
                            <span className="chip chip--muted">有效・無參考價</span>
                          ) : (
                            <span className="chip chip--ok">{r.status === 'delayed' ? '有效・延遲' : '有效'}</span>
                          )}
                          {r.status === 'mock' ? <span className="cell-note">模擬資料</span> : null}
                          {r.note ? <span className="cell-note">{r.note}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <nav className="pager" aria-label="分頁">
            <span className="small soft">
              第 <span className="num">{data.page}</span> / <span className="num">{data.pages}</span> 頁・每頁 20 筆
            </span>
            <div className="pager__pages">
              {data.page > 1 ? <Link className="btn" href={href(q, data.page - 1)} style={{ textDecoration: 'none' }}>上一頁</Link> : <span className="btn" aria-disabled="true" style={{ color: 'var(--ink-disabled)' }}>上一頁</span>}
              {Array.from({ length: data.pages }, (_, i) => i + 1)
                .filter((n) => Math.abs(n - data.page) <= 2 || n === 1 || n === data.pages)
                .map((n) => (
                  <Link key={n} className="pg" href={href(q, n)} aria-current={n === data.page ? 'page' : undefined} aria-label={`第 ${n} 頁`} style={{ display: 'inline-grid', placeItems: 'center', textDecoration: 'none' }}>
                    {n}
                  </Link>
                ))}
              {data.page < data.pages ? <Link className="btn" href={href(q, data.page + 1)} style={{ textDecoration: 'none' }}>下一頁</Link> : <span className="btn" aria-disabled="true" style={{ color: 'var(--ink-disabled)' }}>下一頁</span>}
            </div>
          </nav>
        </section>
      </main>
    </>
  );
}
