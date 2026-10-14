// 切換頁面時立刻顯示的載入畫面（資料在伺服器端讀取，讀完就換成實際內容）

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="載入中">
      <div className="page-head on-gold">
        <div className="page-head__text">
          <span className="skeleton" style={{ width: 90, height: 14 }} />
          <span className="skeleton" style={{ width: 220, height: 40 }} />
          <span className="skeleton" style={{ width: 280, height: 16 }} />
        </div>
      </div>
      <main className="page">
        <div className="row">
          <section className="card col-main" style={{ minHeight: 280 }}>
            <span className="skeleton" style={{ width: 120, height: 14 }} />
            <span className="skeleton" style={{ width: '60%', height: 56 }} />
            <span className="skeleton" style={{ width: '40%', height: 20 }} />
            <span className="skeleton" style={{ width: '90%', height: 14 }} />
          </section>
          <section className="card col-side" style={{ minHeight: 280 }}>
            <span className="skeleton" style={{ width: 140, height: 14 }} />
            <span className="skeleton" style={{ width: '70%', height: 28 }} />
            <span className="skeleton" style={{ width: '100%', height: 12 }} />
          </section>
        </div>
        <span className="visually-hidden">載入中…</span>
      </main>
    </div>
  );
}
