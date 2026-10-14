import { NoticeBands, SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getPageDeps } from '@/lib/server';
import { loadChrome } from '@/lib/view/chrome';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const chrome = await loadChrome(await getPageDeps());
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
