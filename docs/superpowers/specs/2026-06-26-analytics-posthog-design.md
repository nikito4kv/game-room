# Аналитика на PostHog — дизайн

> Дата: 2026-06-26. Статус: согласовано, готово к плану реализации.
> Контекст: [SPEC.md](../../../SPEC.md) (метрики роста, строки 45–46), [ROADMAP.md](../../../ROADMAP.md).

## 1. Цель

Сделать продукт «зрячим»: измерять рост по четырём метрикам, которые мы заранее
считаем решающими (k-фактор и удержание). Метрики:

1. **Создал комнату** — сколько комнат создают.
2. **Зашёл по ссылке** — сколько входов по приглашению (вход на `/room/[code]`).
3. **Сколько человек в комнате** — пик одновременных + всего уникальных прошло.
4. **Вернулся через неделю** — недельное удержание (retention).

Дополнительно — **k-фактор** (вирусность): один создатель → сколько новых
посетителей привёл по ссылке.

Требования: просто, приватно, бесплатно на старте; смотреть дашборды в браузере
и иметь файловый экспорт-снимок.

## 2. Решения (зафиксированы)

| Решение | Выбор | Почему |
|---|---|---|
| Инструмент | **PostHog** | Нативный retention по когортам, воронки, дашборды из коробки. |
| Хостинг | **PostHog Cloud EU** | Бесплатный тариф (~1 млн событий/мес — кратный запас), данные в ЕС (GDPR), нулевой DevOps. |
| Сбор на клиенте | **Только свои события + `$pageview`** | `autocapture` и session recording выключены: максимум приватности, чистые данные, маленький бандл. |
| «Сколько человек в комнате» | **Пик одновременных + всего уникальных** | Пик = реальный co-presence (главная ценность), уникальные = охват. |
| Дашборды | **Родной UI PostHog** | Воронки/retention/тренды из коробки — отдельную страницу не строим. |
| Экспорт | **CLI-скрипт → Markdown** | PostHog уже даёт живую браузерную аналитику; файл нужен как читаемый датированный снимок. Один формат — MD. |

## 3. Архитектура

Две дорожки сбора. Разделяем «действия человека» и «истины о комнате».

- **Клиент (`posthog-js`)** — события, привязанные к анонимному `distinct_id`
  посетителя (нужно для воронки и retention).
- **Сервер (`posthog-node` из вебхука LiveKit)** — истины, которым нельзя
  доверять клиенту (обрывы, закрытые вкладки): пик, уникальные, длительность.

Истины о комнате **не привязываются к человеку** — это метрики комнаты, а не
пользователя. Поэтому сшивать серверный и клиентский `distinct_id` не нужно;
для серверных событий используем `distinct_id = "room:<code>"` как группировку.

```
Браузер ──$pageview, room_created, room_joined──► PostHog Cloud EU
                                                        ▲
LiveKit ──webhook: joined / finished──► /api/livekit-webhook
                                       │  (Upstash Redis: peak / uniq)
                                       └──room_session (peak, uniq, duration)──┘
```

> **Реализовано (отклонения от первоначального дизайна):**
> 1. Пик берём из `event.room.numParticipants` (приходит в `participant_joined`),
>    поэтому свой live-счётчик и обработка `participant_left` не нужны.
> 2. Длительность и `is_public` берём из payload `room_finished`
>    (`event.room.creationTime`, `event.room.metadata`) — на `room_finished`
>    комната в LiveKit уже удалена, `loadPublicMeta` вернул бы `null`.
> 3. Клиент инициализируется через `src/instrumentation-client.ts`
>    (`onRouterTransitionStart`), а не провайдером в `layout.tsx`.

## 4. Таксономия событий

### Клиентские

| Событие | Когда | Свойства |
|---|---|---|
| `$pageview` | смена маршрута (`/`, `/rooms`, `/room/[code]`) | URL без точного кода комнаты |
| `room_created` | успешный `POST /api/rooms` | `is_public`, `has_password` |
| `room_joined` | успешный коннект к LiveKit | `entry` (`link` \| `code` \| `created`), `is_public` |

`entry`:
- `link` — посетитель зашёл прямо на `/room/[code]` (вход «по ссылке»);
- `code` — ввёл код на лендинге;
- `created` — зашёл в свою только что созданную комнату.

### Серверное

| Событие | Когда | Свойства |
|---|---|---|
| `room_session` | webhook `room_finished` | `peak_participants`, `total_unique`, `duration_sec`, `is_public` |

`duration_sec` = `event.createdAt − event.room.creationTime` (оба из payload
вебхука, в секундах). На `room_finished` комната уже удалена, поэтому НЕ читаем
её через API, а берём всё из самого события.

### Что НЕ отправляем

Ник, пароль, содержимое чата — никакого PII.

Код комнаты — случайный несекретный токен (не PII), он и так известен всем
участникам. На сервере используем его как ключ группировки
(`distinct_id = "room:<code>"`). Из клиентских `$pageview` URL код **режем** —
чтобы не плодить высокую кардинальность в отчётах и не светить список активных
комнат в общей аналитике.

## 5. Маппинг метрик

| Метрика | Источник в PostHog |
|---|---|
| Создал комнату | тренд по `room_created` + 1-й шаг воронки |
| Зашёл по ссылке | `room_joined` где `entry = link` (тренд) |
| Сколько в комнате | `room_session.peak_participants` и `total_unique` |
| Вернулся через неделю | нативный Retention (недельные когорты) по `room_joined` |
| k-фактор | (в экспорте) новые посетители с `entry=link` / число создателей за период |

## 6. Компоненты (что строим)

### Новые модули

- **`src/lib/analytics/posthogClient.ts`** — ленивая инициализация `posthog-js`:
  ключ `NEXT_PUBLIC_POSTHOG_KEY`, host EU, `autocapture: false`,
  `disable_session_recording: true`, persistence `localStorage` (стабильный
  анонимный id между визитами — нужно для retention). Типизированный
  `track(event, props)` + константы имён событий.
- **`src/lib/analytics/posthogServer.ts`** — ленивый `posthog-node` (рядом с
  `redis.ts`, серверный-only): ключ `POSTHOG_KEY`, host EU. После `capture`
  обязательно `await flush()` — на serverless инстанс может «замёрзнуть» до
  отправки.
- **`src/lib/analytics/roomStats.ts`** — статистика в Upstash Redis:
  `recordJoin` (один атомарный Lua-`eval`: `SADD` ника, `peak = max(peak, n)`,
  запись публичности, продление TTL), `readStats` (чтение без удаления),
  `cleanupStats` (удаление). Чистая логика, покрывается тестом. Ключи:
  `room:<code>:peak` (STRING), `room:<code>:uniq` (SET), `room:<code>:pub`
  (STRING `1`/`0`), TTL = `ROOM_STATE_TTL_SECONDS` (как у состояния комнаты).
  Чтение и удаление разделены, чтобы стирать только после успешной отправки.

### Изменения в существующем

- **`src/app/api/livekit-webhook/route.ts`**:
  - `participant_joined` → `recordJoin(code, identity, numParticipants, isPublic)`,
    запускается ПАРАЛЛЕЛЬНО с модерацией (не задерживает кик/мьют);
  - `room_finished` → `readStats` → если были участники, `captureRoomSession`
    (`await flush`) → `cleanupStats` (удаление ТОЛЬКО после успешной отправки).
    Длительность считается из payload с защитой от невалидных меток времени.
  - Сбои аналитики не должны валить вебхук (LiveKit иначе ретраит) — отдельные
    try/catch, как уже сделано с очисткой.
- **`src/instrumentation-client.ts`** (Next 15.3+) — `initAnalytics()` + первый
  `$pageview`; `onRouterTransitionStart` шлёт `$pageview` на клиентских навигациях
  (нормализуя `/room/<code>` → `/room/[code]`).
- **Создание комнаты** — `room_created` в обработчике успешного `POST /api/rooms`.
- **`src/app/room/[code]/RoomClient.tsx`** — `room_joined` после успешного
  коннекта, с вычислением `entry`.

### Экспорт

- **`scripts/analytics-export.mjs`** — через PostHog **Query API (HogQL)**:
  4 метрики + k-фактор → датированный `analytics-export/YYYY-MM-DD.md` (таблицы).
  Ключи `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` — локально в env.
  Папка `analytics-export/` в `.gitignore`.

### Зависимости

`posthog-js`, `posthog-node`.

### Переменные окружения

| Переменная | Где | Назначение |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | клиент | project API key |
| `NEXT_PUBLIC_POSTHOG_HOST` | клиент | `https://eu.i.posthog.com` |
| `POSTHOG_KEY` | сервер | тот же project key для `posthog-node` |
| `POSTHOG_PERSONAL_API_KEY` | только экспорт-скрипт | Query API |
| `POSTHOG_PROJECT_ID` | только экспорт-скрипт | id проекта |

## 7. Приватность

- Хостинг **ЕС** (GDPR), данные не покидают EU.
- **Никакого PII** (см. §4).
- Анонимный first-party `distinct_id` в `localStorage`, без логина. Это
  единственный компромисс — нужен для retention. Для анонимной first-party
  аналитики в ЕС cookie-баннер по «законному интересу» обычно не обязателен;
  в MVP добавляем **одну строку в политику конфиденциальности**, без баннера
  (YAGNI).
- `autocapture` и session recording выключены.

## 8. Дашборды (настраиваются в UI PostHog)

Собираем в один Dashboard «Game Room — рост»:
- **Trends:** `room_session`/день (комнат/день), средний `peak_participants`,
  средний `duration_sec`, гистограмма `peak_participants`.
- **Funnel:** `$pageview` (лендинг) → `room_created` → `room_joined`.
- **Retention:** недельный, по `room_joined`.

## 9. Тесты (vitest)

- `roomStats.test.ts` — peak/unique/публичность/чтение-без-удаления/cleanup.
- Роутинг вебхука: `participant_left` уменьшает счётчик; `room_finished` шлёт
  `room_session` с верными числами (PostHog-клиент мокаем).

## 10. Ручные шаги (вне кода)

1. Завести проект в PostHog Cloud EU, получить ключи.
2. Убедиться, что в LiveKit Cloud включены webhook-события `room_finished` и
   `participant_joined` (этого достаточно — `participant_left` НЕ нужен).
3. Прописать env-переменные (локально и в проде).
4. Собрать дашборды по §8.
5. Добавить в политику конфиденциальности строку про анонимную аналитику
   (PostHog Cloud EU, без PII).

## 11. Вне рамок (YAGNI)

- Аккаунты/логин и персональная история.
- Cookie-баннер согласия.
- In-app админ-страница аналитики (смотрим в PostHog).
- Autocapture, session recording, heatmaps.
- Экспорт в JSON (живые данные — в PostHog; файл — читаемый MD-снимок).
