// Серверная отправка «истин о комнате» в PostHog. Импортируется ТОЛЬКО из
// серверных Route Handlers / вебхука (как redis.ts) — ключ не должен попасть в
// клиент. События о комнате не привязываем к человеку: distinctId = "room:<code>"
// (см. дизайн-спеку §3) — это метрика комнаты, а не пользователя.
import { PostHog } from "posthog-node";
import { DEFAULT_POSTHOG_INGESTION_HOST } from "./constants";

let _client: PostHog | null = null;
// Запоминаем, что аналитика отключена (нет ключа), чтобы не дёргать env каждый раз.
let _disabled = false;

/**
 * Ленивый клиент posthog-node. Возвращает null, если POSTHOG_KEY не задан —
 * тогда аналитика просто отключена (локальная разработка без неё не падает).
 *
 * flushAt:1 + ручной flush() после capture обязательны на serverless: инстанс
 * может «замёрзнуть»/завершиться сразу после ответа, не успев отправить батч.
 */
function getClient(): PostHog | null {
  if (_disabled) return null;
  if (_client) return _client;

  const key = process.env.POSTHOG_KEY;
  if (!key) {
    _disabled = true;
    return null;
  }
  _client = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_INGESTION_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  return _client;
}

export type RoomSession = {
  code: string;
  peak: number;
  totalUnique: number;
  durationSec: number;
  isPublic: boolean;
};

/**
 * Отправить событие room_session (комната закрылась) и дождаться доставки.
 * No-op, если аналитика отключена. Бросать наружу не должна — вызывающий
 * (вебхук) и так оборачивает в try/catch, но flush ждём здесь.
 */
export async function captureRoomSession(session: RoomSession): Promise<void> {
  const client = getClient();
  if (!client) return;

  client.capture({
    distinctId: `room:${session.code}`,
    event: "room_session",
    properties: {
      peak_participants: session.peak,
      total_unique: session.totalUnique,
      duration_sec: session.durationSec,
      is_public: session.isPublic,
    },
  });
  await client.flush();
}
