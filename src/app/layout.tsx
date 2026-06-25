import type { Metadata } from "next";
import { Exo_2, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import SiteNav from "@/components/SiteNav";
import { getBaseUrl } from "@/lib/baseUrl";

// Три семейства дизайн-системы, self-hosted через next/font, с кириллицей.
// Каждое отдаёт CSS-переменную, на которую ссылаются токены скина (tokens.css):
//   --font-exo2 → --font-display, --font-inter → --font-ui, --font-jbmono → --font-mono
// Все три — вариативные шрифты, поэтому weight не указываем (рекомендация next/font).
const display = Exo_2({
  subsets: ["latin", "cyrillic"],
  variable: "--font-exo2",
  display: "swap",
});

const ui = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-jbmono",
  display: "swap",
});

const DESCRIPTION =
  "Голосовая игровая комната без регистрации — заходи по коду.";

export const metadata: Metadata = {
  // Абсолютная база для og:url и относительных путей OG-картинок: краулеры
  // Discord/Telegram разворачивают только абсолютные ссылки. Дочерние страницы
  // (напр. комната) переопределяют title/openGraph через generateMetadata.
  metadataBase: new URL(getBaseUrl()),
  title: {
    default: "Game Room",
    template: "%s · Game Room",
  },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Game Room",
    locale: "ru_RU",
    title: "Game Room",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Game Room",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      data-skin="arena"
      className={`${display.variable} ${ui.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
