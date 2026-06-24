import { NextResponse } from "next/server";
import { TrackSource } from "livekit-server-sdk";
import {
  getRoomService,
  loadPublicMeta,
  savePublicMeta,
  verifyHostCredentials,
  type RoomPublicMeta,
} from "@/lib/livekit";
import { loadSecret, saveSecret, type RoomSecret } from "@/lib/roomSecret";
import { clientIp, moderateLimit, rateLimited } from "@/lib/ratelimit";

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
  const limited = await rateLimited(moderateLimit(), clientIp(request));
  if (limited) return limited;

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

  let meta: RoomPublicMeta | null;
  let secret: RoomSecret | null;
  try {
    [meta, secret] = await Promise.all([loadPublicMeta(code), loadSecret(code)]);
  } catch (err) {
    console.error("load room state failed", err);
    return NextResponse.json({ error: "Сервис недоступен" }, { status: 502 });
  }
  if (!meta || !secret) {
    return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
  }

  // Авторизация: либо мастер-ключ создателя, либо токен текущего хоста.
  const { isHost, callerIdentity } = await verifyHostCredentials(meta, secret, {
    hostKey: body.hostKey,
    callerToken: body.callerToken,
    code,
  });

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
        await savePublicMeta(code, meta);
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
        const banned = new Set(secret.banned);
        banned.add(target!);
        secret.banned = [...banned];
        await saveSecret(code, secret);
        // Удаляем уже зашедшего; если его нет — не страшно.
        await service.removeParticipant(code, target!).catch(() => {});
        break;
      }
      case "unban": {
        secret.banned = secret.banned.filter((n) => n !== target);
        await saveSecret(code, secret);
        break;
      }
      case "mute":
      case "unmute": {
        const canPublish = action === "unmute";
        // Состояние мьюта храним в секрете комнаты, чтобы оно пережило
        // переподключение участника (иначе перезагрузка снимала бы мьют).
        const mutedSet = new Set(secret.mutedIdentities);
        if (canPublish) mutedSet.delete(target!);
        else mutedSet.add(target!);
        secret.mutedIdentities = [...mutedSet];
        await saveSecret(code, secret);
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
        await savePublicMeta(code, meta);
        break;
      }
      case "lock":
      case "unlock": {
        meta.locked = action === "lock";
        await savePublicMeta(code, meta);
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
