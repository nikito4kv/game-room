"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Глобальное верхнее меню: две вкладки с подсветкой текущей страницы.
// Раньше навигация дублировалась в шапке каждой страницы (ghost-ссылка
// «Публичные комнаты» на главной, «На главную» в витрине) — теперь единое
// предсказуемое место. На экране комнаты (/room/*) меню скрыто: там свой
// полноэкранный HUD с доком, верхняя панель была бы лишней.

const TABS: { href: string; label: string }[] = [
  { href: "/", label: "Главная" },
  { href: "/rooms", label: "Комнаты" },
];

export default function SiteNav() {
  const pathname = usePathname() ?? "/";
  if (pathname.startsWith("/room/")) return null;

  return (
    <header className="site-nav">
      <div className="site-nav-inner">
        <Link href="/" className="site-brand" aria-label="Game Room — на главную">
          Game<span className="text-accent-hi"> Room</span>
        </Link>
        <nav className="nav" aria-label="Основная навигация">
          {TABS.map((tab) => {
            // «Главная» активна только на точном «/»; «Комнаты» — на /rooms и вложенных.
            const active =
              tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className="nav-link"
                data-active={active}
                aria-current={active ? "page" : undefined}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
