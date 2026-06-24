// Приватное состояние комнаты — живёт в Upstash Redis, НЕ в metadata LiveKit.
// metadata LiveKit раздаётся всем участникам, поэтому хэши и списки банов/мьютов
// держим тут, на сервере. Публичные поля (title/hostIdentity/locked/…) остаются
// в metadata комнаты (см. RoomPublicMeta в livekit.ts).
//
// ХРАНЕНИЕ. Раньше всё лежало одним JSON-блобом, который перезаписывался целиком
// (read-modify-write) — это давало гонки: два параллельных изменения затирали
// друг друга. Теперь каждая изменяемая коллекция — нативный Redis-SET, а её
// мутация (sadd/srem) атомарна и идемпотентна сама по себе:
//   room:<CODE>:auth     HASH { passwordHash?, hostKeyHash }  (пишется один раз)
//   room:<CODE>:banned   SET ников
//   room:<CODE>:members  SET ников (кому можно вернуться в закрытую комнату)
//   room:<CODE>:muted    SET ников (мьют переживает реконнект)
// passwordHash/hostKeyHash после создания не меняются → гонок по ним нет.
// `auth` — авторитетный маркер существования приватного состояния комнаты.
import { getRedisRaw } from "./redis";

export type RoomAuth = {
  /** null — пароля нет; иначе "salt:hash" (см. hashPassword). */
  passwordHash: string | null;
  /** Хэш секрета хоста ("salt:hash"). Подтверждает права хоста. */
  hostKeyHash: string;
};

// TTL — страховка от мусора, если вебхук room_finished не придёт. Рефрешится при
// АКТИВНОСТИ (вход в комнату, participant_joined), а не только при записи —
// иначе на долгоживущей комнате без модерации ключи истекали бы и комната
// «ломалась». 6 часов с запасом больше любого промежутка активности живой
// комнаты (пустую LiveKit удаляет сам через empty/departureTimeout).
export const ROOM_STATE_TTL_SECONDS = 6 * 60 * 60; // 6 часов

const kAuth = (code: string) => `room:${code}:auth`;
const kBanned = (code: string) => `room:${code}:banned`;
const kMembers = (code: string) => `room:${code}:members`;
const kMuted = (code: string) => `room:${code}:muted`;
const allKeys = (code: string) => [kAuth(code), kMembers(code), kBanned(code), kMuted(code)];

// auth храним как JSON-СТРОКУ (set/get), а не как Redis-HASH. Почему: raw-клиент
// (automaticDeserialization:false) для hgetall отдаёт ПЛОСКИЙ массив [поле,знач,…],
// а не объект (кастомный десериализатор обходится), и auth.hostKeyHash был бы
// undefined. Строка же читается raw-клиентом как есть, а парсим её сами —
// заодно не рискуем тем, что авто-парсер превратит хэш-из-одних-цифр в число.
function parseAuth(raw: unknown): RoomAuth | null {
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw) as { hostKeyHash?: unknown; passwordHash?: unknown };
    if (typeof o.hostKeyHash !== "string" || !o.hostKeyHash) return null;
    return {
      hostKeyHash: o.hostKeyHash,
      passwordHash: typeof o.passwordHash === "string" ? o.passwordHash : null,
    };
  } catch {
    return null;
  }
}

/** Создаёт приватное состояние комнаты при её создании (одним pipeline). */
export async function createRoomState(
  code: string,
  opts: { passwordHash: string | null; hostKeyHash: string; initialMember: string },
): Promise<void> {
  const authJson = JSON.stringify({
    hostKeyHash: opts.hostKeyHash,
    passwordHash: opts.passwordHash, // null, если пароля нет
  });
  const p = getRedisRaw().pipeline();
  p.set(kAuth(code), authJson);
  p.sadd(kMembers(code), opts.initialMember);
  p.expire(kAuth(code), ROOM_STATE_TTL_SECONDS);
  p.expire(kMembers(code), ROOM_STATE_TTL_SECONDS);
  await p.exec();
}

/** Удаляет всё приватное состояние комнаты (уборка при закрытии комнаты). */
export async function deleteRoomState(code: string): Promise<void> {
  await getRedisRaw().del(...allKeys(code));
}

/** Читает неизменяемую auth-часть. null — состояния нет (комната «пропала»). */
export async function loadAuth(code: string): Promise<RoomAuth | null> {
  return parseAuth(await getRedisRaw().get<string>(kAuth(code)));
}

/**
 * Батч-чтение auth по многим комнатам за ОДИН pipeline (витрина публичных
 * комнат: иначе был бы N+1 — отдельный round-trip на каждую). В Map присутствует
 * КАЖДЫЙ запрошенный код: значение null — приватного состояния нет (комната
 * нежизнеспособна, /api/token её отвергнет). Если сам pipeline упадёт — пробросит
 * исключение (вызывающий решает, как деградировать).
 */
export async function loadAuthMany(codes: string[]): Promise<Map<string, RoomAuth | null>> {
  const result = new Map<string, RoomAuth | null>();
  if (codes.length === 0) return result;
  const p = getRedisRaw().pipeline();
  for (const code of codes) p.get(kAuth(code));
  const raws = (await p.exec()) as (string | null)[];
  codes.forEach((code, i) => result.set(code, parseAuth(raws[i])));
  return result;
}

/**
 * Продлевает TTL всех существующих ключей комнаты до полного срока. Зовётся при
 * активности (успешный вход, participant_joined), чтобы живая комната не теряла
 * состояние. expire на несуществующем ключе — no-op.
 */
export async function touchTtl(code: string): Promise<void> {
  const p = getRedisRaw().pipeline();
  for (const key of allKeys(code)) p.expire(key, ROOM_STATE_TTL_SECONDS);
  await p.exec();
}

// --- Общие операции над сетами комнаты (атомарны и идемпотентны) ---
// Единая политика «add с TTL» / srem / sismember — чтобы у банов/членов/мьютов
// не разъехалось поведение (TTL-on-write задаётся в одном месте).
type KeyFn = (code: string) => string;
async function addToSet(keyFn: KeyFn, code: string, nick: string): Promise<void> {
  const key = keyFn(code);
  const p = getRedisRaw().pipeline();
  p.sadd(key, nick);
  p.expire(key, ROOM_STATE_TTL_SECONDS);
  await p.exec();
}
async function removeFromSet(keyFn: KeyFn, code: string, nick: string): Promise<void> {
  await getRedisRaw().srem(keyFn(code), nick);
}
async function hasInSet(keyFn: KeyFn, code: string, nick: string): Promise<boolean> {
  return (await getRedisRaw().sismember(keyFn(code), nick)) === 1;
}

// --- Баны ---
export const addBan = (code: string, nick: string): Promise<void> => addToSet(kBanned, code, nick);
export const removeBan = (code: string, nick: string): Promise<void> =>
  removeFromSet(kBanned, code, nick);
export const isBanned = (code: string, nick: string): Promise<boolean> =>
  hasInSet(kBanned, code, nick);

// --- Члены (кому можно вернуться в закрытую комнату) ---
export const addMember = (code: string, nick: string): Promise<void> =>
  addToSet(kMembers, code, nick);
export const removeMember = (code: string, nick: string): Promise<void> =>
  removeFromSet(kMembers, code, nick);
export const isMember = (code: string, nick: string): Promise<boolean> =>
  hasInSet(kMembers, code, nick);

/**
 * Горячий путь входа: добавляет участника И продлевает TTL всех ключей комнаты
 * за ОДИН pipeline (одна сетевая операция вместо addMember + touchTtl).
 */
export async function addMemberAndRefreshTtl(code: string, nick: string): Promise<void> {
  const p = getRedisRaw().pipeline();
  p.sadd(kMembers(code), nick);
  for (const key of allKeys(code)) p.expire(key, ROOM_STATE_TTL_SECONDS);
  await p.exec();
}

// --- Мьюты ---
export const addMute = (code: string, nick: string): Promise<void> => addToSet(kMuted, code, nick);
export const removeMute = (code: string, nick: string): Promise<void> =>
  removeFromSet(kMuted, code, nick);
export const isMuted = (code: string, nick: string): Promise<boolean> =>
  hasInSet(kMuted, code, nick);

/**
 * Горячий путь входа: за один pipeline отдаёт auth + все три проверки по нику.
 * Возвращает null, если состояния нет (auth отсутствует). Это снимок-в-полёте
 * (не транзакция) — реальное принуждение бана/мьюта/замка дублируется вебхуком
 * participant_joined.
 */
export async function loadJoinChecks(
  code: string,
  nick: string,
): Promise<{ auth: RoomAuth; banned: boolean; member: boolean; muted: boolean } | null> {
  const p = getRedisRaw().pipeline();
  p.get(kAuth(code));
  p.sismember(kBanned(code), nick);
  p.sismember(kMembers(code), nick);
  p.sismember(kMuted(code), nick);
  const [authRaw, banned, member, muted] = (await p.exec()) as [
    string | null,
    number,
    number,
    number,
  ];
  const auth = parseAuth(authRaw);
  if (!auth) return null;
  return {
    auth,
    banned: banned === 1,
    member: member === 1,
    muted: muted === 1,
  };
}
