// Статистика комнаты для аналитики — копит «истины», которые знает только сервер:
// пик одновременных участников, сколько уникальных ников прошло через комнату и
// была ли комната публичной. Живёт в Upstash Redis рядом с приватным состоянием
// комнаты (см. roomSecret.ts): собирается в вебхуке LiveKit (participant_joined),
// считывается и шлётся в PostHog на room_finished.
//
//   room:<CODE>:peak   STRING — максимум LiveKit numParticipants за жизнь комнаты
//   room:<CODE>:uniq   SET    — ники, заходившие в комнату (мощность = охват)
//   room:<CODE>:pub    STRING — "1"/"0", была ли комната публичной (на случай,
//                               если в payload room_finished не будет metadata)
//
// Используем raw-клиент (automaticDeserialization:false): ники в сете — это
// произвольные строки (тот же резон, что и в roomSecret.ts).
import { getRedisRaw } from "../redis";
import { ROOM_STATE_TTL_SECONDS } from "../roomSecret";

const kPeak = (code: string) => `room:${code}:peak`;
const kUniq = (code: string) => `room:${code}:uniq`;
const kPub = (code: string) => `room:${code}:pub`;

// Один атомарный round-trip (Lua) на вход: добавляем ник в множество уникальных,
// поднимаем пик до max(текущий, n), запоминаем публичность и продлеваем TTL всех
// трёх ключей. Атомарность убирает гонку get→set при одновременных входах, а один
// round-trip вместо нескольких разгружает горячий путь вебхука.
const RECORD_JOIN_LUA = `
local n = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > cur then redis.call('SET', KEYS[1], n) end
redis.call('SET', KEYS[3], ARGV[4])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('EXPIRE', KEYS[3], ttl)
return 1
`;

/**
 * Зафиксировать вход участника. `numParticipants` — серверная истина из вебхука
 * LiveKit (event.room.numParticipants). Вход означает присутствие как минимум
 * одного человека, поэтому пик не опускаем ниже 1: если LiveKit пришлёт 0/мусор
 * (поле не гарантировано актуальным на participant_joined), метрика не схлопнется
 * в 0. TTL согласован с приватным состоянием комнаты (ROOM_STATE_TTL_SECONDS).
 */
export async function recordJoin(
  code: string,
  identity: string,
  numParticipants: number,
  isPublic: boolean,
): Promise<void> {
  const n = Math.max(Number.isFinite(numParticipants) ? numParticipants : 0, 1);
  await getRedisRaw().eval(
    RECORD_JOIN_LUA,
    [kPeak(code), kUniq(code), kPub(code)],
    [String(n), String(ROOM_STATE_TTL_SECONDS), identity, isPublic ? "1" : "0"],
  );
}

export type RoomStats = { peak: number; totalUnique: number; isPublic: boolean };

/**
 * Прочитать накопленную статистику БЕЗ удаления. Удаление вынесено в
 * `cleanupStats`, чтобы стирать ключи только ПОСЛЕ успешной отправки в PostHog —
 * иначе при сетевом сбое событие room_session терялось бы безвозвратно
 * (room_finished приходит один раз). Несостоявшаяся очистка не страшна: ключи
 * сами истекут по TTL.
 */
export async function readStats(code: string): Promise<RoomStats> {
  const raw = getRedisRaw();
  const p = raw.pipeline();
  p.get(kPeak(code));
  p.scard(kUniq(code));
  p.get(kPub(code));
  const [peakRaw, uniq, pubRaw] = (await p.exec()) as [string | null, number, string | null];
  return {
    peak: Number(peakRaw) || 0,
    totalUnique: Number(uniq) || 0,
    isPublic: pubRaw === "1",
  };
}

/** Стереть ключи статистики комнаты (один round-trip). */
export async function cleanupStats(code: string): Promise<void> {
  await getRedisRaw().del(kPeak(code), kUniq(code), kPub(code));
}
