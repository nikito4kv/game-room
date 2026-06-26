// Чистые помощники по URL — без зависимостей от SDK (ни posthog-js, ни Sentry),
// чтобы их можно было импортировать в любом рантайме (клиент/сервер/edge) и в
// тестах, не утягивая лишние бандлы. Используются и аналитикой, и Sentry.

// Код комнаты в пути: `/room/<code>`. Останавливаемся на разделителях пути,
// пробелах и типичных «кавычках» URL внутри текста/заголовков. Группа — сам код.
const ROOM_CODE_RE = /\/room\/([^/\s?#"'`\\)]+)/;
// Глобальная версия для замены всех вхождений в произвольной строке.
const ROOM_CODE_RE_GLOBAL = new RegExp(ROOM_CODE_RE.source, "g");

/**
 * Привести путь к виду без секретов: `/room/ABC123` → `/room/[code]`. Так код
 * комнаты не попадает в отчёты (pageview PostHog) и не плодит высокую
 * кардинальность. Принимает как полный URL, так и голый путь; возвращает путь.
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

/**
 * Вырезать код комнаты ИЗ ЛЮБОЙ строки (URL, текст ошибки, заголовок Referer),
 * сохраняя остальное: `...failed /room/ABC123/chat` → `...failed /room/[code]/chat`.
 * В отличие от normalizePath не схлопывает строку до pathname — годится для
 * сообщений и заголовков, где важен контекст вокруг.
 */
export function scrubRoomCodes(text: string): string {
  return text.replace(ROOM_CODE_RE_GLOBAL, "/room/[code]");
}

/**
 * Достать код комнаты из строки (URL/путь/Referer) — для корреляции в Sentry.
 * Возвращает первый найденный код или null.
 */
export function extractRoomCode(text: string): string | null {
  const m = text.match(ROOM_CODE_RE);
  if (!m) return null;
  // Идемпотентность: на уже затёртом `/room/[code]` не возвращаем плейсхолдер
  // как «код» (иначе повторный прогон события дал бы тег hashRoomCode("[code]")).
  return m[1] === "[code]" ? null : m[1];
}
