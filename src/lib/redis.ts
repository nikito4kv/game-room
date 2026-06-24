// ВАЖНО: этот модуль импортируется только из серверных Route Handlers / вебхука.
// Токен Upstash не должен попадать в клиентские компоненты.
import { Redis } from "@upstash/redis";
import { requireEnv } from "./livekit";

/**
 * Ленивый общий клиент Upstash Redis.
 *
 * Зачем Redis, если у проекта «нет своей БД»: приватное состояние комнаты
 * (хэш пароля, хэш ключа хоста, баны, мьюты) НЕЛЬЗЯ держать в metadata комнаты
 * LiveKit — их LiveKit раздаёт всем участникам. Поэтому секреты живут здесь, на
 * стороне сервера, а в metadata остаётся только публичное. Этим же Redis
 * пользуется rate limiting (см. ratelimit.ts).
 */
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: requireEnv("UPSTASH_REDIS_REST_URL"),
      token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return _redis;
}

let _redisRaw: Redis | null = null;

/**
 * Клиент БЕЗ автоматической (де)сериализации JSON. Нужен для состояния комнаты
 * (см. roomSecret.ts), которое хранится в Redis-сетах: члены сета — это ники,
 * то есть произвольные строки. С `automaticDeserialization` (включена по
 * умолчанию) ник вида "42" вернулся бы из `smembers` числом, а ник с `{`/`:`
 * мог бы упасть на JSON.parse. Тут ники гоняются как непрозрачные строки.
 * Обычный getRedis() (с авто-парсингом) остаётся для rate limiting.
 */
export function getRedisRaw(): Redis {
  if (!_redisRaw) {
    _redisRaw = new Redis({
      url: requireEnv("UPSTASH_REDIS_REST_URL"),
      token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
      automaticDeserialization: false,
    });
  }
  return _redisRaw;
}
