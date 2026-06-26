// Общие опции Sentry — одна точка правды для трёх рантаймов (клиент/сервер/edge),
// чтобы конфиг не расходился по копиям (тот же принцип, что constants.ts у PostHog).
//
// Приватность на одной линии с PostHog: sendDefaultPii=false, код комнаты
// вырезается из ВСЕХ текстовых полей события (URL, заголовки, текст ошибок,
// хлебные крошки) в beforeSend. Режим «только ошибки»: Performance и Session
// Replay не подключаем (tracesSampleRate=0, профильные интеграции не добавляем —
// дефолтный набор их не содержит, поэтому tree-shaking их выкинет).
//
// Без DSN всё no-op (enabled=false) — локальная разработка ничего не шлёт.
import type { ErrorEvent } from "@sentry/nextjs";
import { extractRoomCode, scrubRoomCodes } from "@/lib/url";
import { hashRoomCode } from "@/lib/hash";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Окружение для тега в дашборде. На Vercel клиент читает NEXT_PUBLIC_VERCEL_ENV
 * (экспонируется автоматически), сервер/edge — VERCEL_ENV; локально — development.
 * Так prod и preview разнесены.
 */
function resolveEnvironment(): string {
  return process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || "development";
}

type Headers = Record<string, string> | undefined;

/** Найти значение первого подходящего заголовка (регистронезависимо). */
function findHeader(headers: Headers, names: string[]): string | null {
  if (!headers) return null;
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase()) && typeof headers[key] === "string") {
      return headers[key];
    }
  }
  return null;
}

/** Вырезать код комнаты из всех строковых значений заголовков (на месте). */
function scrubHeaderValues(headers: Headers): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (typeof headers[key] === "string") {
      headers[key] = scrubRoomCodes(headers[key]);
    }
  }
}

/**
 * beforeSend: (1) вывести тег `room` для корреляции — в т.ч. для серверных/edge
 * ошибок, где клиентский scope недоступен (берём код из URL события или Referer);
 * (2) вырезать код комнаты из ВСЕХ текстовых полей. Чистая функция — её зовёт
 * beforeSend, и она же покрыта юнит-тестом. Порядок важен: код достаём ДО скрабинга.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const req = event.request;

  // (1) Тег комнаты. Не перетираем уже выставленный клиентом (setRoomContext).
  const fromUrl = typeof req?.url === "string" ? extractRoomCode(req.url) : null;
  const referer = findHeader(req?.headers as Headers, ["referer", "referrer"]);
  const code = fromUrl ?? (referer ? extractRoomCode(referer) : null);
  if (code && !event.tags?.room) {
    event.tags = { ...event.tags, room: hashRoomCode(code) };
  }

  // (2) Скрабинг кода комнаты отовсюду, где он может всплыть.
  if (typeof event.message === "string") {
    event.message = scrubRoomCodes(event.message);
  }
  if (req?.url) {
    req.url = scrubRoomCodes(req.url);
  }
  scrubHeaderValues(req?.headers as Headers);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") {
      ex.value = scrubRoomCodes(ex.value);
    }
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === "string") {
      crumb.message = scrubRoomCodes(crumb.message);
    }
    const data = crumb.data;
    if (data) {
      for (const key of Object.keys(data)) {
        if (typeof data[key] === "string") {
          data[key] = scrubRoomCodes(data[key]);
        }
      }
    }
  }
  return event;
}

/**
 * Стартовый список шума, который не несёт ценности. Подтюнивается по первым
 * реальным данным — лучше сначала видеть лишнее, чем потерять настоящий баг.
 */
const ignoreErrors = [
  // Безобидный шум браузера, не баг приложения.
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
  // Ожидаемые обрывы соединения LiveKit/WebRTC — это не ошибка приложения.
  "Client initiated disconnect",
];

/**
 * Общие опции для Sentry.init во всех рантаймах. Каждый конфиг спредит их и при
 * необходимости добавляет своё. Намеренно НЕ задаём `integrations` — пустой
 * массив снёс бы дефолтные интеграции (включая перехват глобальных ошибок).
 */
export const sentryCommonOptions = {
  dsn,
  enabled: Boolean(dsn),
  environment: resolveEnvironment(),
  // Режим «только ошибки»: трейсинг выключен.
  tracesSampleRate: 0,
  // Приватность: ни IP, ни тела запроса.
  sendDefaultPii: false,
  ignoreErrors,
  beforeSend: scrubEvent,
};
