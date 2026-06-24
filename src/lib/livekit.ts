// ВАЖНО: этот модуль импортируется только из серверных Route Handlers.
// Секреты LiveKit не должны попадать в клиентские компоненты.
import { randomInt, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  AccessToken,
  RoomServiceClient,
  TokenVerifier,
  WebhookReceiver,
} from "livekit-server-sdk";

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
  /**
   * Ники, забаненные на время жизни комнаты (Этап 5). Их не пускаем обратно.
   * Бан — в пределах сессии: после удаления комнаты список исчезает.
   */
  banned?: string[];
  /**
   * Комната закрыта для НОВЫХ участников (замок). Существующие могут
   * переподключаться; новые ники — нет. Закрывает обход бана сменой ника.
   */
  locked?: boolean;
  /**
   * Ники, которые уже были в комнате. Нужно, чтобы при замке свой участник мог
   * вернуться после перезагрузки (а новый — нет). Не путать с правами: членство
   * не даёт ничего, кроме права переподключиться в закрытую комнату.
   */
  members?: string[];
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

let _webhookReceiver: WebhookReceiver | null = null;

/** Ленивый приёмник вебхуков LiveKit (проверяет подпись теми же ключами). */
export function getWebhookReceiver(): WebhookReceiver {
  if (!_webhookReceiver) {
    _webhookReceiver = new WebhookReceiver(
      requireEnv("LIVEKIT_API_KEY"),
      requireEnv("LIVEKIT_API_SECRET"),
    );
  }
  return _webhookReceiver;
}

let _tokenVerifier: TokenVerifier | null = null;

/** Ленивый верификатор JWT-токенов (та же пара ключей). */
function getTokenVerifier(): TokenVerifier {
  if (!_tokenVerifier) {
    _tokenVerifier = new TokenVerifier(
      requireEnv("LIVEKIT_API_KEY"),
      requireEnv("LIVEKIT_API_SECRET"),
    );
  }
  return _tokenVerifier;
}

/**
 * Проверяет подпись LiveKit-токена и возвращает подтверждённый ник (identity),
 * если токен валиден и выдан для ЭТОЙ комнаты. Иначе null. Так модераторские
 * запросы доказывают «я — этот участник», и выдать себя за другого нельзя
 * (LiveKit гарантирует уникальность identity в комнате).
 */
export async function verifyTokenIdentity(
  token: string,
  code: string,
): Promise<string | null> {
  try {
    const claims = await getTokenVerifier().verify(token);
    const identity = claims.sub;
    if (!identity || claims.video?.room !== code) return null;
    return identity;
  } catch {
    return null;
  }
}

/** Читает и парсит метаданные комнаты. null — комнаты нет или метаданных нет. */
export async function loadRoomMeta(code: string): Promise<RoomMeta | null> {
  const rooms = await getRoomService().listRooms([code]);
  const room = rooms[0];
  if (!room?.metadata) return null;
  return JSON.parse(room.metadata) as RoomMeta;
}

/** Перезаписывает метаданные комнаты целиком (read-modify-write на вызывающем). */
export async function saveRoomMeta(code: string, meta: RoomMeta): Promise<void> {
  await getRoomService().updateRoomMetadata(code, JSON.stringify(meta));
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
