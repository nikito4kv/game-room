import { NextResponse } from "next/server";
import { TrackSource } from "livekit-server-sdk";
import {
  getRoomService,
  loadRoomMeta,
  saveRoomMeta,
  verifyPassword,
  verifyTokenIdentity,
  type RoomMeta,
} from "@/lib/livekit";

// Единая точка модерации хоста (Этап 5): кик/бан/мьют/передача прав/замок.
// Все действия идут через сервер с секретными ключами LiveKit — клиент сам
// ничего из этого сделать не может.

type Action =
  | "kick"
  | "ban"
  | "unban"
  | "mute"
  | "unmute"
  | "transfer"
  | "lock"
  | "unlock";

const ACTIONS_NEEDING_TARGET: ReadonlySet<Action> = new Set([
  "kick",
  "ban",
  "unban",
  "mute",
  "unmute",
  "transfer",
]);

type ModerateBody = {
  code?: string;
  action?: Action;
  target?: string;
  /** Секрет хоста (мастер-ключ создателя) — один из способов авторизации. */
  hostKey?: string;
  /** Собственный LiveKit-токен вызывающего — второй способ авторизации. */
  callerToken?: string;
};

export async function POST(request: Request) {
  let body: ModerateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const code = body.code?.trim().toUpperCase();
  const action = body.action;
  const target = body.target?.trim();

  if (!code) {
    return NextResponse.json({ error: "Не указана комната" }, { status: 400 });
  }
  if (!action) {
    return NextResponse.json({ error: "Не указано действие" }, { status: 400 });
  }
  if (ACTIONS_NEEDING_TARGET.has(action) && !target) {
    return NextResponse.json({ error: "Не указан участник" }, { status: 400 });
  }

  const service = getRoomService();

  let meta: RoomMeta | null;
  try {
    meta = await loadRoomMeta(code);
  } catch (err) {
    console.error("loadRoomMeta failed", err);
    return NextResponse.json({ error: "Сервис недоступен" }, { status: 502 });
  }
  if (!meta) {
    return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
  }

  // Авторизация: либо мастер-ключ создателя, либо токен текущего хоста.
  const byHostKey = Boolean(
    body.hostKey &&
      meta.hostKeyHash &&
      (await verifyPassword(body.hostKey.trim(), meta.hostKeyHash)),
  );
  let callerIdentity: string | null = null;
  if (!byHostKey && body.callerToken) {
    callerIdentity = await verifyTokenIdentity(body.callerToken, code);
  }
  const isHost = byHostKey || (callerIdentity !== null && callerIdentity === meta.hostIdentity);

  // Авто-передача прав: когда хост вышел, оставшийся участник может «занять»
  // вакантное место хоста — но только для СЕБЯ и только если текущего хоста
  // действительно нет в комнате. Это единственный путь модерации без прав хоста.
  if (!isHost) {
    if (action === "transfer" && callerIdentity && target === callerIdentity) {
      const parts = await service.listParticipants(code);
      const hostPresent = parts.some((x) => x.identity === meta.hostIdentity);
      const callerPresent = parts.some((x) => x.identity === callerIdentity);
      if (!hostPresent && callerPresent) {
        meta.hostIdentity = callerIdentity;
        await saveRoomMeta(code, meta);
        return NextResponse.json({ ok: true });
      }
    }
    return NextResponse.json({ error: "Нужны права хоста" }, { status: 403 });
  }

  // Нельзя модерировать самого хоста (кик/бан/мьют). Передача прав себе — no-op.
  if (
    (action === "kick" || action === "ban" || action === "mute") &&
    target === meta.hostIdentity
  ) {
    return NextResponse.json(
      { error: "Нельзя применить это к хосту" },
      { status: 400 },
    );
  }

  try {
    switch (action) {
      case "kick": {
        // Если участник уже вышел — это не ошибка, цель достигнута.
        await service.removeParticipant(code, target!).catch(() => {});
        break;
      }
      case "ban": {
        const banned = new Set(meta.banned ?? []);
        banned.add(target!);
        meta.banned = [...banned];
        await saveRoomMeta(code, meta);
        // Удаляем уже зашедшего; если его нет — не страшно.
        await service.removeParticipant(code, target!).catch(() => {});
        break;
      }
      case "unban": {
        meta.banned = (meta.banned ?? []).filter((n) => n !== target);
        await saveRoomMeta(code, meta);
        break;
      }
      case "mute":
      case "unmute": {
        const canPublish = action === "unmute";
        // Сохраняем флаг в metadata участника, чтобы все клиенты показали
        // «заглушён хостом». Мержим с существующими метаданными участника.
        const parts = await service.listParticipants(code);
        const p = parts.find((x) => x.identity === target);
        if (!p) {
          return NextResponse.json(
            { error: "Участник не в комнате" },
            { status: 404 },
          );
        }
        let pmeta: Record<string, unknown> = {};
        if (p.metadata) {
          try {
            pmeta = JSON.parse(p.metadata) as Record<string, unknown>;
          } catch {
            pmeta = {};
          }
        }
        pmeta.forceMuted = !canPublish;
        // Глушим ТОЛЬКО микрофон: при mute разрешаем публиковать всё, кроме
        // микрофона (через canPublishSources), чтобы не убить демонстрацию
        // экрана. При unmute снимаем ограничение (пустой список = можно всё).
        // ВАЖНО: пропущенные поля permission трактуются как false, поэтому
        // задаём весь нужный набор явно (иначе отвалится приём/данные).
        await service.updateParticipant(code, target!, JSON.stringify(pmeta), {
          canSubscribe: true,
          canPublish: true,
          canPublishData: true,
          canPublishSources: canPublish
            ? []
            : [
                TrackSource.CAMERA,
                TrackSource.SCREEN_SHARE,
                TrackSource.SCREEN_SHARE_AUDIO,
              ],
        });
        break;
      }
      case "transfer": {
        const parts = await service.listParticipants(code);
        if (!parts.some((x) => x.identity === target)) {
          return NextResponse.json(
            { error: "Участник не в комнате" },
            { status: 404 },
          );
        }
        meta.hostIdentity = target!;
        await saveRoomMeta(code, meta);
        break;
      }
      case "lock":
      case "unlock": {
        meta.locked = action === "lock";
        await saveRoomMeta(code, meta);
        break;
      }
      default: {
        return NextResponse.json(
          { error: "Неизвестное действие" },
          { status: 400 },
        );
      }
    }
  } catch (err) {
    console.error(`moderate ${action} failed`, err);
    return NextResponse.json(
      { error: "Не удалось выполнить действие" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
