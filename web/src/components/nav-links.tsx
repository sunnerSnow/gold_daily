'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: '儀表板' },
  { href: '/history', label: '歷史資料' },
  { href: '/settings', label: '推播設定' },
  { href: '/status', label: '系統狀態' },
];

export function NavLinks({ className, ariaLabel }: { className: string; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav className={className} aria-label={ariaLabel}>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
