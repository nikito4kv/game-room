import { NextResponse } from "next/server";
import {
  createAccessToken,
  getRoomService,
  getServerUrl,
  verifyHostCredentials,
  verifyPassword,
  type RoomPublicMeta,
} from "@/lib/livekit";
import { loadSecret, saveSecret } from "@/lib/roomSecret";
import { clientIp, rateLimited, tokenLimit } from "@/lib/ratelimit";

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
  // Лимит по IP+комнате — против перебора пароля и кодов комнат.
  if (code) {
    const limited = await rateLimited(tokenLimit(), `${clientIp(request)}:${code}`);
    if (limited) return limited;
  }
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

  // Публичные метаданные — из LiveKit; приватные (хэши, баны, мьюты) — из Redis.
  // Если метаданные есть, но не парсятся, или секрета нет — не пускаем (иначе
  // можно было бы обойти пароль на повреждённой комнате).
  let meta: RoomPublicMeta | null = null;
  if (room.metadata) {
    try {
      meta = JSON.parse(room.metadata) as RoomPublicMeta;
    } catch (err) {
      console.error("bad room metadata", err);
      return NextResponse.json(
        { error: "Комната повреждена. Создайте новую." },
        { status: 500 },
      );
    }
  }
  let secret;
  try {
    secret = await loadSecret(code);
  } catch (err) {
    console.error("loadSecret failed", err);
    return NextResponse.json({ error: "Сервис недоступен. Попробуйте позже." }, { status: 502 });
  }
  if (!meta || !secret) {
    return NextResponse.json(
      { error: "Комната повреждена. Создайте новую." },
      { status: 500 },
    );
  }

  // 2. Права хоста подтверждаются секретом (hostKey ↔ secret.hostKeyHash). НО
  // обход бана/замка даём только ДЕЙСТВУЮЩЕМУ хосту (ник совпадает с
  // hostIdentity), а не любому, у кого в localStorage лежит ключ. Иначе вторая
  // вкладка того же браузера, где создавали комнату, обходила бы бан и замок.
  const { isHost } = await verifyHostCredentials(meta, secret, { hostKey, code });
  const isCurrentHost = isHost && nickname === meta.hostIdentity;

  // 3. Бан (Этап 5): забаненный ник не пускаем. Действующего хоста — нельзя.
  if (!isCurrentHost && secret.banned.includes(nickname)) {
    return NextResponse.json(
      { error: "Вас забанили в этой комнате" },
      { status: 403 },
    );
  }

  // 4. Проверка пароля (если задан).
  if (secret.passwordHash) {
    if (!password || !(await verifyPassword(password, secret.passwordHash))) {
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
    const wasMember = secret.members.includes(nickname);
    if (meta.locked && !isCurrentHost && !wasMember) {
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

  // 6. Мьют переживает переподключение: если ник заглушён хостом, зашиваем это в
  // сам токен (флаг forceMuted для UI + ограниченный canPublishSources). Иначе
  // достаточно было бы перезагрузить страницу, чтобы снять мьют.
  const muted = secret.mutedIdentities.includes(nickname);

  // 7. Выдаём токен.
  const token = await createAccessToken({
    room: code,
    identity: nickname,
    isHost,
    forceMuted: muted,
    restrictPublish: muted,
  });

  // Запоминаем ник как участника (best-effort), чтобы при замке он мог вернуться
  // после перезагрузки. Перечитываем свежий секрет прямо перед записью, чтобы не
  // затереть только что выставленный бан/мьют другим запросом.
  try {
    const fresh = await loadSecret(code);
    if (fresh && !fresh.members.includes(nickname)) {
      fresh.members = [...fresh.members, nickname];
      await saveSecret(code, fresh);
    }
  } catch {
    // не критично — членство нужно только для реконнекта в закрытую комнату
  }

  return NextResponse.json({
    token,
    serverUrl: getServerUrl(),
    title: meta.title,
    isHost,
  });
}
