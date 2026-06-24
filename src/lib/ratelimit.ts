// Rate limiting поверх Upstash Redis. На Vercel (serverless) счётчик в памяти
// процесса ненадёжен — инстансы не делят память; поэтому считаем в Redis.
import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./redis";

// Скользящее окно. Лимитеры ленивые: создаём при первом обращении, чтобы не
// дёргать env (через getRedis) на этапе сборки.
let _token: Ratelimit | null = null;
let _tokenCodeFail: Ratelimit | null = null;
let _createRoom: Ratelimit | null = null;
let _listRooms: Ratelimit | null = null;
let _moderate: Ratelimit | null = null;
let _upload: Ratelimit | null = null;

/** Вход в комнату: ключ IP:CODE — против перебора пароля и кодов комнат. */
export function tokenLimit(): Ratelimit {
  if (!_token) {
    _token = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, "1 m"),
      prefix: "rl:token",
    });
  }
  return _token;
}

/**
 * Глобальный лимит НЕУДАЧНЫХ попыток пароля на КОМНАТУ (ключ — код, поверх
 * IP+CODE-лимита). Код публичной комнаты виден в витрине, поэтому per-IP-лимит
 * обходится ротацией IP; счётчик по коду гасит распределённый перебор. Списываем
 * ТОЛЬКО при неверном пароле — верный вход лимитер не трогает, легитимных не бьёт.
 */
export function tokenCodeFailLimit(): Ratelimit {
  if (!_tokenCodeFail) {
    _tokenCodeFail = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(20, "10 m"),
      prefix: "rl:tokenFail",
    });
  }
  return _tokenCodeFail;
}

/** Создание комнат: ключ IP — против спама комнат. */
export function createRoomLimit(): Ratelimit {
  if (!_createRoom) {
    _createRoom = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, "1 m"),
      prefix: "rl:createRoom",
    });
  }
  return _createRoom;
}

/** Листинг публичных комнат: ключ IP — умеренный лимит для витрины. */
export function listRoomsLimit(): Ratelimit {
  if (!_listRooms) {
    _listRooms = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(30, "1 m"),
      prefix: "rl:listRooms",
    });
  }
  return _listRooms;
}

/** Модерация: ключ IP — умеренный лимит. */
export function moderateLimit(): Ratelimit {
  if (!_moderate) {
    _moderate = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(30, "1 m"),
      prefix: "rl:moderate",
    });
  }
  return _moderate;
}

/** Загрузка карт: ключ IP — умеренный лимит. */
export function uploadLimit(): Ratelimit {
  if (!_upload) {
    _upload = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      prefix: "rl:upload",
    });
  }
  return _upload;
}

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
