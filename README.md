This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Переменные окружения

Скопируй `.env.example` в `.env.local` и заполни значениями. Полный перечень
переменных и их назначение — в самом `.env.example` (LiveKit, Upstash Redis,
PostHog).

## Аналитика (PostHog)

Аналитика роста — на **PostHog Cloud EU**. Дизайн, метрики и таксономия событий
описаны в
[docs/superpowers/specs/2026-06-26-analytics-posthog-design.md](docs/superpowers/specs/2026-06-26-analytics-posthog-design.md).

- **Дашборды** (воронки, retention-когорты, тренды) смотрим в UI PostHog. Собрать
  их по §8 спеки: Trends (`room_session`/день, средний `peak_participants`,
  средняя длительность, распределение пика), Funnel (`$pageview` → `room_created`
  → `room_joined`), Retention (недельный по `room_joined`).
- **Экспорт снимка в Markdown:**

  ```bash
  npm run analytics:export        # за последние 30 дней
  npm run analytics:export -- 7   # за последние 7 дней
  ```

  Отчёт пишется в `analytics-export/<дата>.md` (в git не коммитится). Нужны
  `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` в `.env.local`.
- Без `NEXT_PUBLIC_POSTHOG_KEY`/`POSTHOG_KEY` аналитика просто отключается —
  локальная разработка работает без неё.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
