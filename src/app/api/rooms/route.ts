import { NextResponse } from "next/server";
import {
  generateHostKey,
  getRoomService,
  hashPassword,
  reserveRoomCode,
  type RoomPublicMeta,
} from "@/lib/livekit";
import { createRoomState } from "@/lib/roomSecret";
import { clientIp, createRoomLimit, rateLimited } from "@/lib/ratelimit";

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
