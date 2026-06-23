// ВАЖНО: этот модуль импортируется только из серверных Route Handlers.
// Секреты LiveKit не должны попадать в клиентские компоненты.
import { randomInt, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

/**
 * Серверные хелперы для работы с LiveKit.
 * Все секреты (LIVEKIT_API_KEY / LIVEKIT_API_SECRET) живут только здесь —
 * на сервере. В клиент они никогда не попадают.
 */

const scryptAsync = promisify(scrypt);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана переменная окружения ${name} (см. .env.local)`);
  }
  return value;
}

// Server API ходит по http(s), а LIVEKIT_URL у нас в виде wss:// — конвертируем.
function httpHost(): string {
  return requireEnv("LIVEKIT_URL").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

/** Публичный wss-URL LiveKit для клиента (с валидацией, что он задан). */
export function getServerUrl(): string {
  return requireEnv("NEXT_PUBLIC_LIVEKIT_URL");
}

/** Метаданные комнаты, которые мы храним прямо в LiveKit (без своей БД). */
export type RoomMeta = {
  title: string;
  isPublic: boolean;
  /** null — пароля нет; иначе строка вида "salt:hash". */
  passwordHash: string | null;
  /** ник создателя комнаты (для отображения/будущей авто-передачи прав). */
  hostIdentity: string;
  /**
   * Хэш секрета хоста ("salt:hash"). Права хоста подтверждаются ЭТИМ секретом,
   * а не совпадением ника, — иначе любой мог бы стать хостом, взяв чужой ник.
   */
  hostKeyHash: string;
  createdAt: number;
};

let _roomService: RoomServiceClient | null = null;

/** Ленивый общий экземпляр клиента Server API. */
export function getRoomService(): RoomServiceClient {
  if (!_roomService) {
    _roomService = new RoomServiceClient(
      httpHost(),
      requireEnv("LIVEKIT_API_KEY"),
      requireEnv("LIVEKIT_API_SECRET"),
    );
  }
  return _roomService;
}

// Алфавит без похожих символов (нет 0/O, 1/I/L) — код проще диктовать друзьям.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/** Генерирует короткий код комнаты, напр. "K7QMP4". */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Подбирает код, которого ещё нет среди активных комнат (защита от коллизии). */
export async function reserveRoomCode(attempts = 6): Promise<string> {
  const service = getRoomService();
  for (let i = 0; i < attempts; i++) {
    const candidate = generateRoomCode();
    const existing = await service.listRooms([candidate]);
    if (existing.length === 0) return candidate;
  }
  throw new Error("Не удалось подобрать свободный код комнаты");
}

/** Секрет хоста — длинная случайная строка, выдаётся создателю комнаты. */
export function generateHostKey(): string {
  return randomBytes(24).toString("hex");
}

/** Хэширует пароль комнаты (scrypt + соль). Формат результата: "salt:hash" (hex). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Проверяет пароль против сохранённого хэша. Сравнение — константное по времени. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  // keylen = expected.length → буферы заведомо одной длины для timingSafeEqual.
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return timingSafeEqual(derived, expected);
}

/** Создаёт JWT-токен доступа в комнату для конкретного ника. */
export async function createAccessToken(opts: {
  room: string;
  identity: string;
  isHost: boolean;
}): Promise<string> {
  const at = new AccessToken(
    requireEnv("LIVEKIT_API_KEY"),
    requireEnv("LIVEKIT_API_SECRET"),
    {
      identity: opts.identity,
      // metadata участника — пригодится UI (например, отметить хоста).
      metadata: JSON.stringify({ isHost: opts.isHost }),
      ttl: "2h",
    },
  );
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true, // понадобится доске тактик (Этап 4)
  });
  return at.toJwt();
}
