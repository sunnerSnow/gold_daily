import { NoticeBands, SiteFooter, SiteHeader } from '@/components/site-chrome';
import { buildDeps } from '@/lib/server';
import { loadChrome } from '@/lib/view/chrome';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const chrome = await loadChrome(await buildDeps());
  return (
    <div className="app-shell">
      <NoticeBands chrome={chrome} />
      <div className="on-gold">
        <SiteHeader chrome={chrome} />
      </div>
      {children}
      <SiteFooter chrome={chrome} />
    </div>
  );
}
