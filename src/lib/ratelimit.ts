// Rate limiting поверх Upstash Redis. На Vercel (serverless) счётчик в памяти
// процесса ненадёжен — инстансы не делят память; поэтому считаем в Redis.
import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./redis";

// Скользящее окно. Лимитеры ленивые: создаём при первом обращении, чтобы не
// дёргать env (через getRedis) на этапе сборки.
// Один фабричный helper вместо шести почти одинаковых синглтонов. Инстанс
// создаётся лениво при первом вызове (env через getRedis не дёргается на сборке).
type LimitWindow = Parameters<typeof Ratelimit.slidingWindow>[1];
function lazyLimiter(tokens: number, window: LimitWindow, prefix: string): () => Ratelimit {
  let inst: Ratelimit | null = null;
  return () =>
    (inst ??= new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(tokens, window),
      prefix,
    }));
}

/** Вход в комнату: ключ IP:CODE — против перебора пароля и кодов комнат. */
export const tokenLimit = lazyLimiter(10, "1 m", "rl:token");

/**
 * Глобальный лимит НЕУДАЧНЫХ попыток пароля на КОМНАТУ (ключ — код, поверх
 * IP+CODE-лимита). Код публичной комнаты виден в витрине, поэтому per-IP-лимит
 * обходится ротацией IP; счётчик по коду гасит распределённый перебор. Списываем
 * ТОЛЬКО при неверном пароле — верный вход лимитер не трогает. Осознанный
 * trade-off: во время активной атаки опечатавшийся в пароле тоже словит 429.
 */
export const tokenCodeFailLimit = lazyLimiter(20, "10 m", "rl:tokenFail");

/** Создание комнат: ключ IP — против спама комнат. */
export const createRoomLimit = lazyLimiter(5, "1 m", "rl:createRoom");

/** Листинг публичных комнат: ключ IP — умеренный лимит для витрины. */
export const listRoomsLimit = lazyLimiter(30, "1 m", "rl:listRooms");

/** Модерация: ключ IP — умеренный лимит. */
export const moderateLimit = lazyLimiter(30, "1 m", "rl:moderate");

/** Загрузка карт: ключ IP — умеренный лимит. */
export const uploadLimit = lazyLimiter(20, "1 m", "rl:upload");

/**
 * IP клиента для rate limiting. На Vercel `x-real-ip` выставляет САМА платформа
 * реальным адресом клиента — ему и доверяем. ЛЕВЫЙ элемент `x-forwarded-for`
 * брать нельзя: он задаётся клиентом (прокси дописывают справа), иначе лимит
 * обходился бы сменой заголовка. Фолбэк вне Vercel — ПОСЛЕДНИЙ (правый) элемент
 * x-forwarded-for (адрес от ближайшего доверенного прокси), чтобы хотя бы
 * разделять клиентов, а не сваливать всех в один общий ключ. "local" — дев.
 */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return "local";
}

/**
 * Проверяет лимит. Если превышен — возвращает готовый ответ 429, иначе null.
 * Использование: `const limited = await rateLimited(tokenLimit(), id); if (limited) return limited;`
 */
export async function rateLimited(
  limiter: Ratelimit,
  identifier: string,
): Promise<NextResponse | null> {
  try {
    const { success } = await limiter.limit(identifier);
    if (success) return null;
    return NextResponse.json(
      { error: "Слишком много запросов. Подождите немного." },
      { status: 429 },
    );
  } catch (err) {
    // Если Redis недоступен — не блокируем легитимных пользователей (fail-open),
    // но фиксируем в логах. Безопасность остальных проверок при этом сохраняется.
    console.error("rate limit check failed", err);
    return null;
  }
}
