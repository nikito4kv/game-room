import { NextResponse } from "next/server";
import {
  createAccessToken,
  getRoomService,
  getServerUrl,
  loadRoomMeta,
  saveRoomMeta,
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

  // 2. Права хоста подтверждаются секретом. НО обход бана/замка даём только
  // ДЕЙСТВУЮЩЕМУ хосту (ник совпадает с hostIdentity), а не любому, у кого в
  // localStorage лежит ключ. Иначе вторая вкладка того же браузера, где
  // создавали комнату, подхватывала бы ключ и обходила и бан, и замок.
  const isHost = Boolean(
    hostKey && meta?.hostKeyHash && (await verifyPassword(hostKey, meta.hostKeyHash)),
  );
  const isCurrentHost = isHost && !!meta && nickname === meta.hostIdentity;

  // 3. Бан (Этап 5): забаненный ник не пускаем. Действующего хоста — нельзя.
  if (!isCurrentHost && meta?.banned?.includes(nickname)) {
    return NextResponse.json(
      { error: "Вас забанили в этой комнате" },
      { status: 403 },
    );
  }

  // 4. Проверка пароля (если задан).
  if (meta?.passwordHash) {
    if (!password || !(await verifyPassword(password, meta.passwordHash))) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }
  }

  // 5. Ник не занят + замок комнаты. Проверку не глотаем: если её нельзя
  // выполнить, безопаснее отказать, чем пустить дубль (LiveKit отключит
  // существующего участника с тем же ником).
  try {
    const participants = await service.listParticipants(code);
    const alreadyHere = participants.some((p) => p.identity === nickname);
    if (alreadyHere) {
      return NextResponse.json(
        { error: "Этот ник уже занят в комнате — выберите другой" },
        { status: 409 },
      );
    }
    // Замок: новых участников не пускаем. Свои (кто уже был в комнате) и
    // действующий хост могут вернуться, например после перезагрузки.
    const wasMember = !!meta?.members?.includes(nickname);
    if (meta?.locked && !isCurrentHost && !wasMember) {
      return NextResponse.json(
        { error: "Комната закрыта для новых участников" },
        { status: 403 },
      );
    }
  } catch (err) {
    console.error("listParticipants failed", err);
    return NextResponse.json(
      { error: "Не удалось проверить участников. Попробуйте ещё раз." },
      { status: 502 },
    );
  }

  // 6. Выдаём токен.
  const token = await createAccessToken({ room: code, identity: nickname, isHost });

  // Запоминаем ник как участника (best-effort), чтобы при замке он мог вернуться
  // после перезагрузки. Перечитываем свежие метаданные прямо перед записью, чтобы
  // не затереть только что выставленный бан/замок другим запросом.
  try {
    const fresh = await loadRoomMeta(code);
    if (fresh && !fresh.members?.includes(nickname)) {
      fresh.members = [...(fresh.members ?? []), nickname];
      await saveRoomMeta(code, fresh);
    }
  } catch {
    // не критично — членство нужно только для реконнекта в закрытую комнату
  }

  return NextResponse.json({
    token,
    serverUrl: getServerUrl(),
    title: meta?.title ?? code,
    isHost,
  });
}
