import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import logo from '@/assets/logo.png';
import { LoginForm } from '@/components/login-form';
import { authMode } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';

export const metadata: Metadata = { title: '登入' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const mode = authMode(getEnv());
  const { next } = await searchParams;
  return (
    <div className="app-shell">
      <main className="page on-gold">
        <section className="card login-card" aria-labelledby="login-h">
          <Image src={logo} alt="Gold Daily 每日金價" width={196} height={114} loading="eager" />
          <h1 className="card-title" id="login-h" style={{ fontSize: 28 }}>管理介面登入</h1>
          {mode === 'login' ? (
            <LoginForm next={next ?? '/'} />
          ) : mode === 'locked' ? (
            <div className="note note--warn">
              <span>伺服器尚未設定 <span className="num">ADMIN_PASSWORD</span> 與 <span className="num">SESSION_SECRET</span>（至少 32 字元），管理介面已鎖住。請在部署平台設定後重新部署。</span>
            </div>
          ) : (
            <p className="small">本機開發模式沒有設定密碼，可以直接<Link href="/">進入儀表板</Link>。</p>
          )}
        </section>
      </main>
    </div>
  );
}
