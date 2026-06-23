import { NextResponse } from "next/server";
import {
  createAccessToken,
  getRoomService,
  getServerUrl,
  verifyPassword,
  type RoomMeta,
} from "@/lib/livekit";

const MAX_NICK_LEN = 24;

type TokenBody = {
  code?: string;
  nickname?: string;
  password?: string;
  hostKey?: string;
};

export async function POST(request: Request) {
  let body: TokenBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const code = body.code?.trim().toUpperCase();
  const nickname = body.nickname?.trim();
  const password = body.password?.trim();
  const hostKey = body.hostKey?.trim();

  if (!code) {
    return NextResponse.json({ error: "Введите код комнаты" }, { status: 400 });
  }
  if (!nickname) {
    return NextResponse.json({ error: "Введите ник" }, { status: 400 });
  }
  if (nickname.length > MAX_NICK_LEN) {
    return NextResponse.json({ error: "Слишком длинный ник" }, { status: 400 });
  }

  const service = getRoomService();

  // 1. Комната существует?
  let rooms;
  try {
    rooms = await service.listRooms([code]);
  } catch (err) {
    console.error("listRooms failed", err);
    return NextResponse.json(
      { error: "Сервис недоступен. Попробуйте позже." },
      { status: 502 },
    );
  }
  const room = rooms[0];
  if (!room) {
    return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
  }

  // Метаданные либо корректны, либо отсутствуют. Если они есть, но не парсятся —
  // не пускаем (иначе можно было бы обойти пароль на повреждённой комнате).
  let meta: RoomMeta | null = null;
  if (room.metadata) {
    try {
      meta = JSON.parse(room.metadata) as RoomMeta;
    } catch (err) {
      console.error("bad room metadata", err);
      return NextResponse.json(
        { error: "Комната повреждена. Создайте новую." },
        { status: 500 },
      );
    }
  }

  // 2. Проверка пароля (если задан).
  if (meta?.passwordHash) {
    if (!password || !(await verifyPassword(password, meta.passwordHash))) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }
  }

  // 3. Ник не занят в этой комнате? Проверку не глотаем: если её нельзя
  // выполнить, безопаснее отказать, чем пустить дубль (LiveKit отключит
  // существующего участника с тем же ником).
  try {
    const participants = await service.listParticipants(code);
    if (participants.some((p) => p.identity === nickname)) {
      return NextResponse.json(
        { error: "Этот ник уже занят в комнате — выберите другой" },
        { status: 409 },
      );
    }
  } catch (err) {
    console.error("listParticipants failed", err);
    return NextResponse.json(
      { error: "Не удалось проверить участников. Попробуйте ещё раз." },
      { status: 502 },
    );
  }

  // 4. Права хоста подтверждаются секретом, а не ником.
  const isHost = Boolean(
    hostKey && meta?.hostKeyHash && (await verifyPassword(hostKey, meta.hostKeyHash)),
  );

  // 5. Выдаём токен.
  const token = await createAccessToken({ room: code, identity: nickname, isHost });

  return NextResponse.json({
    token,
    serverUrl: getServerUrl(),
    title: meta?.title ?? code,
    isHost,
  });
}
