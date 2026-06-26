// Клиентская аналитика поверх posthog-js. Тонкая обёртка: единая точка
// инициализации и отправки событий, чтобы имена и конфиг не расходились.
//
// Приватность (см. дизайн-спеку §7): autocapture и session recording выключены,
// шлём только свои события и нормализованные pageview. Если ключ не задан —
// всё превращается в no-op (локальная разработка без аналитики не падает).
import posthog from "posthog-js";
import { DEFAULT_POSTHOG_INGESTION_HOST } from "./constants";

/** Имена событий — одно место правды, чтобы не плодить опечатки. */
export const EVENTS = {
  roomCreated: "room_created",
  roomJoined: "room_joined",
} as const;

let _ready = false;

/**
 * Привести путь к виду без секретов: `/room/ABC123` → `/room/[code]`. Так код
 * комнаты не попадает в pageview-отчёты (и не плодит высокую кардинальность).
 * Принимает как полный URL, так и голый путь.
 */
export function normalizePath(url: string): string {
  let path = url;
  try {
    // Если пришёл полный URL — берём только pathname.
    path = new URL(url, "http://localhost").pathname;
  } catch {
    // уже путь — оставляем как есть
  }
  return path.replace(/^\/room\/[^/]+/, "/room/[code]");
}

/** Инициализация posthog-js. No-op, если нет ключа или мы не в браузере. */
export function initAnalytics(): void {
  if (_ready || typeof window === "undefined") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_INGESTION_HOST,
    autocapture: false,
    disable_session_recording: true,
    // Pageview шлём вручную (initAnalytics + onRouterTransitionStart), чтобы не
    // словить двойной счёт и контролировать нормализацию URL.
    capture_pageview: false,
    persistence: "localStorage",
  });
  _ready = true;
}

/** Отправить произвольное событие. No-op, если аналитика не инициализирована. */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!_ready) return;
  posthog.capture(event, props);
}

/**
 * Отправить $pageview. PostHog ожидает в $current_url абсолютный URL, поэтому
 * приклеиваем origin к нормализованному пути (код комнаты уже вырезан).
 */
export function capturePageview(path: string): void {
  if (!_ready) return;
  const normalized = normalizePath(path);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  posthog.capture("$pageview", { $current_url: origin + normalized });
}
