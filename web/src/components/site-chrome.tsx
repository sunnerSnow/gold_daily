import Link from 'next/link';
import { feedLabel, type Chrome } from '@/lib/view/chrome';
import { REFERENCE_CHART_URL } from '@/lib/line/messages';
import { logoutAction } from '@/app/actions';
import { NavLinks } from './nav-links';

// 頁首、提示橫幅、頁尾。模擬資料與未設定狀態一律明顯標示。

export function NoticeBands({ chrome }: { chrome: Chrome }) {
  return (
    <>
      {chrome.provider.isMock || !chrome.provider.configured ? (
        <div className="mock-band">
          <div className="mock-band__inner">
            <span className="mock-tag">{chrome.provider.isMock ? 'MOCK' : 'NO DATA'}</span>
            <span>
              <b>尚未設定正式行情來源。</b>
              {chrome.provider.isMock
                ? '目前使用 Mock Provider，頁面上所有價格都是模擬資料，不代表真實行情。'
                : '目前沒有行情資料。開發時可設定 GOLD_PRICE_PROVIDER=mock 測試。'}
            </span>
            <Link href="/status#provider">查看來源設定進度 →</Link>
          </div>
        </div>
      ) : null}
      {chrome.storeKind === 'memory' ? (
        <div className="band band--warn">
          <div className="band__inner">
            <b>未設定 Supabase：</b>資料只暫存在這個伺服器行程的記憶體，重新啟動就會清空。
          </div>
        </div>
      ) : null}
      {chrome.auth === 'open-dev' ? (
        <div className="band">
          <div className="band__inner">未設定 ADMIN_PASSWORD 與 SESSION_SECRET：管理介面沒有登入保護（只適合本機開發）。</div>
        </div>
      ) : null}
    </>
  );
}

export function SiteHeader({ chrome }: { chrome: Chrome }) {
  const feedDot = chrome.feed === 'unconfigured' ? 'hchip--gray' : chrome.feed === 'stale' ? 'hchip--red' : 'hchip--gold';
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/">
          <svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true">
            <path className="brand__fill" d="M5 21 L8.5 11 H19.5 L23 21 Z" />
            <path className="brand__stroke" d="M8.5 11 L10.5 7 H17.5 L19.5 11" />
          </svg>
          Gold Daily
        </Link>
        <NavLinks className="nav" ariaLabel="主要導覽" />
        <div className="hchips">
          <span className={`hchip ${feedDot}`}>
            <span className="dot" />
            <span>{feedLabel(chrome)}</span>
          </span>
          <span className={`hchip ${chrome.lineConfigured ? 'hchip--blue' : 'hchip--red'}`}>
            <span className="dot" />
            {chrome.lineConfigured ? 'LINE 已設定' : 'LINE 尚未連線'}
          </span>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ chrome }: { chrome: Chrome }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__row">
          <p className="footer__title">
            每天定時，
            <br />
            把金價送到 LINE。
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <NavLinks className="footer__nav" ariaLabel="頁尾導覽" />
            {chrome.auth === 'login' ? (
              <form action={logoutAction} className="footer__nav">
                <button type="submit" className="btn" style={{ background: 'transparent', color: 'var(--footer-ink)', borderColor: 'var(--footer-line)' }}>
                  登出
                </button>
              </form>
            ) : null}
          </div>
        </div>
        <p className="footer__note">
          所有時間為台北時間（UTC+8），資料庫以 UTC 儲存。提醒門檻是可調整的初始設定，不構成投資建議。行情參考：
          <a href={REFERENCE_CHART_URL} target="_blank" rel="noopener noreferrer">
            Truney 黃金走勢圖
          </a>
        </p>
        <p className="footer__mark" aria-hidden="true">
          Gold Daily
        </p>
      </div>
    </footer>
  );
}

export function PageHead({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
