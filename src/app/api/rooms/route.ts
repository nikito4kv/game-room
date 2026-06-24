import { NextResponse } from "next/server";
import {
  generateHostKey,
  getRoomService,
  hashPassword,
  parseRoomMeta,
  reserveRoomCode,
  type RoomPublicMeta,
} from "@/lib/livekit";
import { createRoomState, loadAuthMany, type RoomAuth } from "@/lib/roomSecret";
import { clientIp, createRoomLimit, listRoomsLimit, rateLimited } from "@/lib/ratelimit";
import {
  sortPublicRooms,
  toPublicRoomSummaries,
  type PublicRoomCandidate,
  type PublicRoomSummary,
} from "@/lib/publicRooms";

const MAX_PARTICIPANTS = 6; // целевой максимум из SPEC (2–6)
// Авто-закрытие комнаты (SPEC: удаляется, когда вышел последний участник).
// В LiveKit это ДВА разных таймаута:
//  - emptyTimeout — сколько держать комнату, пока в неё ещё НИКТО не зашёл
//    (хост создал, но не подключился / разрешает доступ к микрофону).
//  - departureTimeout — сколько держать комнату ПОСЛЕ ухода последнего участника.
// Основной сценарий «поиграли и все вышли» — это departureTimeout; без него
// сработал бы короткий дефолт LiveKit (~20 с), и перезагрузка/обрыв связи убивали
// бы комнату вместе с картами и секретом до того, как участник переподключится.
const EMPTY_TIMEOUT_SEC = 2 * 60; // создал, но ещё никто не зашёл
const DEPARTURE_TIMEOUT_SEC = 90; // все вышли → отсрочка на реконнект

// Серверные лимиты (клиентский maxLength легко обойти прямым запросом).
const MAX_NICK_LEN = 24;
const MAX_TITLE_LEN = 40;
const MAX_PASSWORD_LEN = 128;

type CreateBody = {
  nickname?: string;
  title?: string;
  password?: string;
  isPublic?: boolean;
};

export async function POST(request: Request) {
  const limited = await rateLimited(createRoomLimit(), clientIp(request));
  if (limited) return limited;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const nickname = body.nickname?.trim();
  const title = body.title?.trim();
  const password = body.password?.trim();
  const isPublic = Boolean(body.isPublic);

  if (!nickname) {
    return NextResponse.json({ error: "Введите ник" }, { status: 400 });
  }
  if (nickname.length > MAX_NICK_LEN) {
    return NextResponse.json({ error: "Слишком длинный ник" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "Введите название комнаты" }, { status: 400 });
  }
  if (title.length > MAX_TITLE_LEN) {
    return NextResponse.json({ error: "Слишком длинное название" }, { status: 400 });
  }
  if (password && password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json({ error: "Слишком длинный пароль" }, { status: 400 });
  }

  const hostKey = generateHostKey();
  // Публичная часть — в metadata LiveKit (видна всем участникам).
  const meta: RoomPublicMeta = {
    title,
    isPublic,
    hostIdentity: nickname,
    createdAt: Date.now(),
  };
  // Приватная часть — в Redis (секреты не должны раздаваться участникам).
  const passwordHash = password ? await hashPassword(password) : null;
  const hostKeyHash = await hashPassword(hostKey);

  try {
    const code = await reserveRoomCode();
    await getRoomService().createRoom({
      name: code,
      metadata: JSON.stringify(meta),
      emptyTimeout: EMPTY_TIMEOUT_SEC,
      departureTimeout: DEPARTURE_TIMEOUT_SEC,
      maxParticipants: MAX_PARTICIPANTS,
    });
    // Состояние пишем после создания комнаты — чтобы не плодить осиротевшие записи.
    await createRoomState(code, { passwordHash, hostKeyHash, initialMember: nickname });
    // hostKey возвращаем один раз создателю — он подтверждает права хоста.
    return NextResponse.json({ code, hostKey });
  } catch (err) {
    console.error("createRoom failed", err);
    return NextResponse.json(
      { error: "Не удалось создать комнату. Попробуйте ещё раз." },
      { status: 502 },
    );
  }
}

// Витрина не растёт безгранично: отдаём верхушку отсортированного списка.
const MAX_PUBLIC_ROOMS = 60;
// Короткий кэш в памяти инстанса: ответ одинаков для всех анонимов, поэтому не
// пересчитываем (LiveKit listRooms + Redis) на каждый запрос. Гасит всплески
// опроса/кнопку «обновить». Per-instance на serverless — но всплески ловит.
const LIST_CACHE_TTL_MS = 5_000;
let _listCache: { at: number; rooms: PublicRoomSummary[] } | null = null;

/** Ответ витрины. no-store: ОБЩИЙ кэш/bfcache не должен отдавать чужой/протухший
 *  снимок (коды уже закрытых комнат). Кэш у нас только серверный, в памяти. */
function listResponse(rooms: PublicRoomSummary[]): NextResponse {
  const res = NextResponse.json({ rooms });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Список ПУБЛИЧНЫХ комнат для витрины на лендинге (/rooms).
 * Берём активные комнаты LiveKit, оставляем публичные с валидными metadata и
 * живыми участниками, обогащаем наличием пароля (приватный auth в Redis, одним
 * батчем). Секреты не отдаём: наружу идёт только флаг hasPassword.
 */
export async function GET(request: Request) {
  const limited = await rateLimited(listRoomsLimit(), clientIp(request));
  if (limited) return limited;

  const now = Date.now();
  if (_listCache && now - _listCache.at < LIST_CACHE_TTL_MS) {
    return listResponse(_listCache.rooms);
  }

  try {
    // Без аргументов listRooms возвращает все активные комнаты.
    const rooms = await getRoomService().listRooms();

    // Публичные, с валидной metadata И живыми участниками: «создал, но не зашёл»
    // и «все вышли» (LiveKit держит комнату ещё empty/departureTimeout) в витрине
    // не показываем — в них некого встречать.
    const candidates: PublicRoomCandidate[] = rooms.flatMap((room) => {
      if (room.numParticipants <= 0) return [];
      const meta = parseRoomMeta(room.metadata);
      if (!meta || !meta.isPublic) return [];
      // locked в RoomPublicMeta опционально; в витрине нужен строгий boolean.
      return [
        {
          room,
          meta: {
            title: meta.title,
            hostIdentity: meta.hostIdentity,
            createdAt: meta.createdAt,
            locked: meta.locked === true,
          },
        },
      ];
    });

    // Сортировка и отсечение ДО чтения auth: ключ сортировки не зависит от auth,
    // поэтому батч в Redis делаем только по верхушке (≤ MAX_PUBLIC_ROOMS), а не по
    // всем кандидатам.
    const top = sortPublicRooms(candidates).slice(0, MAX_PUBLIC_ROOMS);

    // Наличие пароля — из приватного auth, ОДНИМ батчем (без N+1). Если чтение
    // целиком упало — список не роняем: помечаем «неизвестно» и трактуем
    // консервативно (защищённую за открытую не выдаём), но такой ответ НЕ кэшируем.
    let authByCode: Map<string, RoomAuth | null>;
    let authOk = true;
    try {
      authByCode = await loadAuthMany(top.map(({ room }) => room.name));
    } catch (err) {
      console.error("loadAuthMany failed", err);
      authByCode = new Map();
      authOk = false;
    }

    const summaries = toPublicRoomSummaries(top, authByCode);

    // Метку ставим на момент завершения (а не старта запроса), и кэшируем только
    // полноценный снимок — деградированный (сбой auth) не должен залипать на TTL.
    if (authOk) _listCache = { at: Date.now(), rooms: summaries };
    return listResponse(summaries);
  } catch (err) {
    console.error("listRooms failed", err);
    return NextResponse.json(
      { error: "Не удалось загрузить список комнат. Попробуйте ещё раз." },
      { status: 502 },
    );
  }
}
