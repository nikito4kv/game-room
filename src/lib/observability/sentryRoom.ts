// Контекст комнаты для Sentry. Чтобы видеть, что ошибки прилетели из одной
// комнаты, ставим тег `room` = необратимый короткий хэш кода (не сам код —
// приватность на одной линии с PostHog, см. дизайн-спеку §5).
//
// Это клиентская часть (тег ставится в браузерном scope). Серверные/edge ошибки
// получают тот же тег централизованно в beforeSend (sentryOptions.scrubEvent) —
// он достаёт код из URL/Referer события и хэширует тем же hashRoomCode.
import * as Sentry from "@sentry/nextjs";
import { hashRoomCode } from "@/lib/hash";

/** Пометить текущую сессию хэшем комнаты. No-op-safe: без DSN тег просто игнорируется. */
export function setRoomContext(code: string): void {
  Sentry.setTag("room", hashRoomCode(code));
}

/** Снять тег комнаты при выходе, чтобы он не «протёк» на последующие ошибки вне комнаты. */
export function clearRoomContext(): void {
  Sentry.setTag("room", undefined);
}
