# Мониторинг ошибок на Sentry — дизайн

> Дата: 2026-06-26. Статус: согласовано, готово к плану реализации.
> Контекст: первые пользователи неизбежно наткнутся на баги, которых мы не
> видели. Цель — узнавать о них **самим, из телеметрии**, а не из жалоб.
> Соседняя телеметрия: [аналитика на PostHog](2026-06-26-analytics-posthog-design.md).

## 1. Цель

Сделать ошибки приложения **видимыми в реальном времени**: крэши в браузере,
необработанные промисы, сбои в Route Handlers и RSC должны автоматически
прилетать в Sentry с читаемым стектрейсом — чтобы мы узнавали о проблеме раньше,
чем о ней сообщит пользователь.

Требования: просто, приватно (на одной линии с PostHog), бесплатно на старте,
без влияния на работу приложения при сбое самой телеметрии.

## 2. Решения (зафиксированы)

| Решение | Выбор | Почему |
|---|---|---|
| Инструмент | **Sentry** | Стандарт для отлова ошибок, бесплатный тариф, email-алерты из коробки. |
| SDK | **Официальный `@sentry/nextjs` v10** | В peerDependencies заявлен `^16.0.0-0` — Next 16 поддержан официально. Автолов React/RSC/Route Handler ошибок + автозагрузка source maps. Меньше ручного кода, чем самосбор. |
| Набор функций | **Только ошибки (errors-only)** | `tracesSampleRate: 0`, без Performance и Session Replay. Под задачу «узнавать о багах» и под жёсткие квоты free-тарифа. |
| Охват | **Клиент + сервер + edge** | Полная картина: баги первых юзеров вылезут и в браузере (LiveKit/UX), и в API. |
| Приватность | **Строго, как в PostHog** | `sendDefaultPii: false`, код комнаты вырезается из URL/breadcrumbs через `beforeSend`. |
| Корреляция | **Тег `room` = хэш кода** | Необратимый короткий хэш — видно, что ошибки из одной комнаты, без раскрытия кода. |
| Gating | **No-op без DSN** | Нет `NEXT_PUBLIC_SENTRY_DSN` → инициализация не выполняется. Локальная разработка не трогает Sentry. |
| Source maps | **Опционально, позже** | Стартуем без `SENTRY_AUTH_TOKEN` (стектрейсы минифицированы). Добавление токена позже включит загрузку без правок кода. |

## 3. Архитектура

Sentry инициализируется в трёх рантаймах Next 16, опции — из одной точки правды,
чтобы конфиг не расходился (тот же принцип, что `constants.ts` у PostHog).

```
                         ┌─────────────────────────────────────┐
                         │  src/lib/observability/               │
                         │    sentryOptions.ts  (общие опции)    │
                         │    sentryRoom.ts     (тег-хэш комнаты)│
                         └───────────────┬───────────────────────┘
                       ┌─────────────────┼─────────────────────┐
                       ▼                 ▼                     ▼
        instrumentation-client.ts  sentry.server.config  sentry.edge.config
        (браузер, рядом с PostHog)  (Node рантайм)         (edge рантайм)
                       │                 │                     │
                       │                 └──── src/instrumentation.ts ────┐
                       │                       register() по NEXT_RUNTIME  │
                       │                       onRequestError = captureReq │
                       ▼                                                   ▼
                 Браузерные ошибки ───────► Sentry ◄──── Серверные/edge ошибки
                                              ▲
                                  next.config.ts → withSentryConfig
                                  (source maps при SENTRY_AUTH_TOKEN)
```

### Поток данных

1. **Клиент:** крэш React / необработанный промис → SDK ловит → `beforeSend`
   режет код комнаты из URL → отправка (если DSN задан).
2. **Сервер/edge:** ошибка в Route Handler / RSC → Next вызывает `onRequestError`
   → `Sentry.captureRequestError` → тот же `beforeSend`.
3. **Локально без DSN:** все три `init` — no-op, ничего не отправляется.

## 4. Компоненты

### 4.1 `src/lib/observability/sentryOptions.ts` — одна точка правды

Общие опции для всех трёх рантаймов:

- `dsn: process.env.NEXT_PUBLIC_SENTRY_DSN` — пусто → SDK сам становится no-op.
- `enabled` — включаем только при наличии DSN.
- `environment` — из `process.env.VERCEL_ENV` (`production` / `preview`), иначе
  `development`. Так preview и prod разделены по тегу.
- `tracesSampleRate: 0` — Performance выключен (errors-only).
- `sendDefaultPii: false` — без IP и прочего PII.
- `beforeSend(event)` — скрабинг (см. §5).
- `ignoreErrors` — стартовый список шума (см. §6).
- Минимальный набор `integrations` — без `browserTracing`/`replay`, чтобы не тянуть лишнее в бандл.

### 4.2 `instrumentation-client.ts` — клиентский init (правим существующий)

Существующий файл уже поднимает PostHog. Дописываем рядом, **не ломая** текущий
блок и его try/catch:

- `Sentry.init({ ...commonOptions })` для браузера.
- `onRouterTransitionStart` композим: вызываем и `capturePageview` (PostHog,
  как сейчас), и `Sentry.captureRouterTransitionStart(url)`.

### 4.3 `sentry.server.config.ts` и `sentry.edge.config.ts` (корень проекта)

Конвенция Sentry: отдельные файлы инициализации для Node и edge рантаймов.
Каждый зовёт `Sentry.init({ ...commonOptions })` с общими опциями.

### 4.4 `src/instrumentation.ts` (новый)

- `register()` — по `process.env.NEXT_RUNTIME` импортирует `sentry.server.config`
  (`nodejs`) или `sentry.edge.config` (`edge`).
- `export const onRequestError = Sentry.captureRequestError` — хук Next 16
  (см. `node_modules/next/dist/docs/.../instrumentation.md`).

### 4.5 `src/lib/observability/sentryRoom.ts` — контекст комнаты

- `setRoomContext(code)` — ставит тег `room` = короткий необратимый хэш кода.
- `clearRoomContext()` — снимает тег при выходе из комнаты.
- Вызывается со страницы комнаты (`src/app/room/...`).

### 4.6 `next.config.ts` — обёртка сборки

Оборачиваем экспорт в `withSentryConfig` с минимальными опциями:

- `telemetry: false` — не шлём метрики самого плагина.
- `silent: true` — тихая сборка.
- Source maps грузятся только при наличии `SENTRY_AUTH_TOKEN` (иначе плагин
  пропускает загрузку без ошибки).

## 5. Приватность и скрабинг

- `sendDefaultPii: false` — Sentry не прикладывает IP и тело запроса.
- `beforeSend` переиспользует `normalizePath` из `posthogClient.ts`: режет
  `/room/ABC123` → `/room/[code]` в `event.request.url` и в URL хлебных крошек
  (breadcrumbs).
- Тег `room` — только хэш, не сам код.
- `tunnelRoute` **не используем** (минимизируем нагрузку на сервер; обход
  адблокеров на free-старте не приоритет).

## 6. Обработка шума

Стартовый `ignoreErrors` для типичного мусора, который не несёт ценности:

- `ResizeObserver loop completed with undelivered notifications`
- Ошибки браузерных расширений (`chrome-extension://`, `moz-extension://` в стеке).
- Ожидаемые дисконнекты LiveKit (по сообщению/типу).

Список заводим с запасом и **подтюниваем по первым реальным данным** — лучше
сначала видеть лишнее, чем молча потерять настоящий баг.

## 7. Окружения и gating

- Нет `NEXT_PUBLIC_SENTRY_DSN` → no-op (локальная разработка молчит).
- `environment` из `VERCEL_ENV` → preview и production разнесены по тегу в
  дашборде.
- Параллельная инициализация с PostHog: оба независимы, сбой одного не валит
  другой (каждый в своём try/catch, как уже сделано для PostHog).

## 8. Тестирование

- **Юнит-тесты** (vitest, как `chat.test.ts`):
  - `beforeSend`-скрабинг: код комнаты вырезается из `request.url` и breadcrumbs.
  - Хэш комнаты: стабильный и не равен исходному коду.
- **Ручная проверка:** временный тестовый `throw` → подтверждаем, что событие
  долетело в дашборд Sentry, а код комнаты в нём уже вырезан. После проверки —
  убрать тестовый throw.

## 9. Алертинг (настройка проекта, вне кода)

На free-тарифе Sentry по умолчанию шлёт email при появлении новых ошибок.
Настраивается в дашборде Sentry; в коде ничего не требуется. Шаг настройки
фиксируем в плане реализации как ручной.

## 10. Зависимости и переменные окружения

- `npm i @sentry/nextjs`
- `.env.example` (и реальные значения в Vercel):
  - `NEXT_PUBLIC_SENTRY_DSN` — DSN проекта (публичный, используется во всех рантаймах).
  - `SENTRY_AUTH_TOKEN` — опц., build-time, для загрузки source maps.
  - `SENTRY_ORG`, `SENTRY_PROJECT` — опц., для загрузки source maps.

## 11. Явно вне объёма (YAGNI)

- Performance / трейсинг.
- Session Replay.
- `tunnelRoute` (обход адблокеров).
- Кастомные дашборды/алерты сверх дефолтных email.
- Привязка ошибок к личности пользователя.
