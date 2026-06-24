// ВАЖНО: этот модуль импортируется только из серверных Route Handlers.
// Секреты LiveKit не должны попадать в клиентские компоненты.
import { randomInt, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  AccessToken,
  RoomServiceClient,
  TokenVerifier,
  TrackSource,
  WebhookReceiver,
} from "livekit-server-sdk";
import type { RoomAuth } from "./roomSecret";

/**
 * Серверные хелперы для работы с LiveKit.
 * Все секреты (LIVEKIT_API_KEY / LIVEKIT_API_SECRET) живут только здесь —
 * на сервере. В клиент они никогда не попадают.
 */

const scryptAsync = promisify(scrypt);

export function requireEnv(name: string): string {
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

/**
 * ПУБЛИЧНЫЕ метаданные комнаты — лежат в metadata комнаты LiveKit и раздаются
 * всем участникам. Поэтому здесь НЕТ секретов (хэши пароля/ключа хоста, баны,
 * мьюты живут в Redis — см. приватное состояние в roomSecret.ts). Клиент читает отсюда
 * hostIdentity (корона) и locked (замок) для UI.
 */
export type RoomPublicMeta = {
  title: string;
  isPublic: boolean;
  /** ник создателя/текущего хоста (для отображения и авто-передачи прав). */
  hostIdentity: string;
  createdAt: number;
  /**
   * Комната закрыта для НОВЫХ участников (замок). Существующие могут
   * переподключаться; новые ники — нет. Закрывает обход бана сменой ника.
   */
  locked?: boolean;
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

// Допуск часов для verify() в режиме allowExpired. Год — заведомо больше любой
// реальной непрерывной сессии: jose не умеет «не проверять exp», поэтому
// просто даём огромный clockTolerance. Число не несущее для безопасности —
// личность всё равно сверяется с живым hostIdentity (см. verifyTokenIdentity).
const EXPIRED_TOKEN_TOLERANCE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Проверяет подпись LiveKit-токена и возвращает подтверждённый ник (identity),
 * если токен валиден и выдан для ЭТОЙ комнаты. Иначе null. Так модераторские
 * запросы доказывают «я — этот участник», и выдать себя за другого нельзя
 * (LiveKit гарантирует уникальность identity в комнате).
 *
 * allowExpired: игнорировать срок действия токена (exp/nbf). Нужен модерации и
 * загрузке карты — там токен используется ТОЛЬКО как доказательство личности, а
 * не как грант на подключение. Подпись/issuer/комната/ник по-прежнему проверяются:
 * подделать токен без LIVEKIT_API_SECRET нельзя, а актуальность хоста проверяется
 * отдельно (callerIdentity === hostIdentity). По умолчанию проверка строгая.
 */
export async function verifyTokenIdentity(
  token: string,
  code: string,
  opts?: { allowExpired?: boolean },
): Promise<string | null> {
  try {
    const claims = await getTokenVerifier().verify(
      token,
      opts?.allowExpired ? EXPIRED_TOKEN_TOLERANCE_SECONDS : undefined,
    );
    const identity = claims.sub;
    if (!identity || claims.video?.room !== code) return null;
    return identity;
  } catch {
    return null;
  }
}

/**
 * Строгий разбор публичных метаданных из НЕДОВЕРЕННОЙ строки LiveKit. Проверяем
 * ФОРМУ (но НЕ isPublic===true — публичность решает вызывающий): объект с
 * непустыми title/hostIdentity, конечным числом createdAt, boolean isPublic и
 * опциональным locked. null — нет/битые/неполные metadata. Единый парсер на все
 * вызовы (loadPublicMeta, витрина, токен) — чтобы трактовка формы не разъезжалась.
 */
export function parseRoomMeta(raw: string | undefined): RoomPublicMeta | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Битые metadata не должны ронять вызывающего (напр. Promise.all в вебхуке —
    // иначе принуждение бана/мьюта молча отключилось бы). Трактуем как «нет meta».
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null; // напр. "null"/число
  const m = parsed as Record<string, unknown>;
  if (typeof m.isPublic !== "boolean") return null;
  if (typeof m.title !== "string" || !m.title) return null;
  if (typeof m.hostIdentity !== "string" || !m.hostIdentity) return null;
  if (typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt)) return null;
  return {
    title: m.title,
    isPublic: m.isPublic,
    hostIdentity: m.hostIdentity,
    createdAt: m.createdAt,
    locked: m.locked === true,
  };
}

/** Читает публичные метаданные комнаты. null — комнаты нет или метаданные битые. */
export async function loadPublicMeta(code: string): Promise<RoomPublicMeta | null> {
  const rooms = await getRoomService().listRooms([code]);
  return parseRoomMeta(rooms[0]?.metadata);
}

/** Перезаписывает публичные метаданные целиком (read-modify-write на вызывающем). */
export async function savePublicMeta(code: string, meta: RoomPublicMeta): Promise<void> {
  await getRoomService().updateRoomMetadata(code, JSON.stringify(meta));
}

/**
 * Подтверждает права хоста двумя способами (как раньше): мастер-ключ создателя
 * (hostKey, сверяется с secret.hostKeyHash) ИЛИ собственный LiveKit-токен
 * текущего хоста (callerToken, ник из него должен совпасть с hostIdentity).
 * Возвращает и подтверждённый ник вызывающего — он нужен для авто-передачи прав.
 */
export async function verifyHostCredentials(
  publicMeta: RoomPublicMeta,
  auth: RoomAuth,
  opts: { hostKey?: string; callerToken?: string; code: string; allowExpiredToken?: boolean },
): Promise<{ byHostKey: boolean; callerIdentity: string | null; isCurrentHost: boolean }> {
  const byHostKey = Boolean(
    opts.hostKey &&
      auth.hostKeyHash &&
      (await verifyPassword(opts.hostKey.trim(), auth.hostKeyHash)),
  );
  let callerIdentity: string | null = null;
  if (opts.callerToken) {
    // allowExpiredToken: для moderate/upload токен — лишь доказательство личности,
    // его срок действия не важен (актуальность хоста ниже сверяется отдельно).
    callerIdentity = await verifyTokenIdentity(opts.callerToken, opts.code, {
      allowExpired: opts.allowExpiredToken,
    });
  }
  // «Текущий хост» — тот, чей ТОКЕН совпал с hostIdentity. Это единый источник
  // правды для moderate/upload: один мастер-ключ не даёт власти над активным
  // хостом (права отзываются при передаче). byHostKey отдаём отдельно — он нужен
  // token при входе (там ещё нет callerToken) и реклейму брошенной комнаты.
  const isCurrentHost = callerIdentity !== null && callerIdentity === publicMeta.hostIdentity;
  return { byHostKey, callerIdentity, isCurrentHost };
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

/** Источники, которые публикует участник. Без микрофона — это «заглушён хостом». */
export const SOURCES_WITHOUT_MIC = [
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

/**
 * Создаёт JWT-токен доступа в комнату для конкретного ника.
 *
 * TTL короткий (30 мин): даже если токен «утечёт» или участник попытается
 * переподключиться напрямую к LiveKit в обход /api/token, окно злоупотребления
 * мало; основное принуждение бана/мьюта — вебхук participant_joined. Этот срок
 * ограничивает ИМЕННО грант на подключение/публикацию. Для модерации и загрузки
 * карты тот же токен используется лишь как доказательство личности — там срок
 * намеренно игнорируется (см. verifyTokenIdentity allowExpired), иначе хост
 * терял бы права через 30 мин, оставаясь в живой комнате.
 *
 * forceMuted/restrictPublish переносят мьют в сам токен: флаг в metadata
 * участника показывает UI «заглушён», а ограниченный canPublishSources не даёт
 * публиковать микрофон даже после перезагрузки страницы.
 */
export async function createAccessToken(opts: {
  room: string;
  identity: string;
  isHost: boolean;
  forceMuted?: boolean;
  restrictPublish?: boolean;
}): Promise<string> {
  const at = new AccessToken(
    requireEnv("LIVEKIT_API_KEY"),
    requireEnv("LIVEKIT_API_SECRET"),
    {
      identity: opts.identity,
      // metadata участника — пригодится UI (отметить хоста, показать «заглушён»).
      metadata: JSON.stringify({ isHost: opts.isHost, forceMuted: !!opts.forceMuted }),
      ttl: "30m",
    },
  );
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true, // понадобится доске тактик (Этап 4)
    // Пустой список = можно публиковать всё. При мьюте убираем микрофон.
    canPublishSources: opts.restrictPublish ? SOURCES_WITHOUT_MIC : undefined,
  });
  return at.toJwt();
}

/**
 * Применяет/снимает принудительный мьют участника: ставит флаг forceMuted в его
 * metadata (мержа с существующей — не теряем isHost) и ограничивает публикацию
 * микрофона. Единая точка для /api/moderate и вебхука, чтобы наборы прав не
 * разъезжались (иначе после реконнекта мьюту вернулся бы микрофон или отвалилась
 * бы демонстрация). При unmute снимаем ограничение (пустой список = можно всё).
 */
export async function enforceParticipantMute(
  service: RoomServiceClient,
  code: string,
  identity: string,
  existingMetadata: string | null | undefined,
  muted: boolean,
): Promise<void> {
  let pmeta: Record<string, unknown> = {};
  if (existingMetadata) {
    try {
      pmeta = JSON.parse(existingMetadata) as Record<string, unknown>;
    } catch {
      pmeta = {};
    }
  }
  pmeta.forceMuted = muted;
  // Пропущенные поля permission трактуются как false — задаём весь набор явно.
  await service.updateParticipant(code, identity, JSON.stringify(pmeta), {
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: muted ? SOURCES_WITHOUT_MIC : [],
  });
}
