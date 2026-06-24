// Приватное состояние комнаты — живёт в Upstash Redis, НЕ в metadata LiveKit.
// metadata LiveKit раздаётся всем участникам, поэтому хэши и списки банов/мьютов
// держим тут, на сервере. Публичные поля (title/hostIdentity/locked/…) остаются
// в metadata комнаты (см. RoomPublicMeta в livekit.ts).
import { getRedis } from "./redis";

export type RoomSecret = {
  /** null — пароля нет; иначе "salt:hash" (см. hashPassword). */
  passwordHash: string | null;
  /** Хэш секрета хоста ("salt:hash"). Подтверждает права хоста. */
  hostKeyHash: string;
  /** Забаненные ники (на время жизни комнаты). */
  banned: string[];
  /** Ники, которые уже были в комнате (для возврата в закрытую комнату). */
  members: string[];
  /** Ники, заглушённые хостом (мьют переживает переподключение). */
  mutedIdentities: string[];
};

// Секрет живёт дольше комнаты с запасом; чистим явно по вебхуку room_finished.
// TTL — страховка от мусора, если вебхук не придёт.
const TTL_SECONDS = 60 * 60 * 24; // 24 часа

const key = (code: string) => `room:${code}:secret`;

/** Читает приватное состояние комнаты. null — записи нет. */
export async function loadSecret(code: string): Promise<RoomSecret | null> {
  // Upstash SDK сам разбирает JSON; get<T> вернёт объект или null.
  const secret = await getRedis().get<RoomSecret>(key(code));
  return secret ?? null;
}

/** Перезаписывает приватное состояние целиком (read-modify-write на вызывающем). */
export async function saveSecret(code: string, secret: RoomSecret): Promise<void> {
  await getRedis().set(key(code), secret, { ex: TTL_SECONDS });
}

/** Удаляет приватное состояние комнаты (уборка при закрытии комнаты). */
export async function deleteSecret(code: string): Promise<void> {
  await getRedis().del(key(code));
}
