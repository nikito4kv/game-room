import { NextResponse } from "next/server";
import {
  enforceParticipantMute,
  getRoomService,
  loadPublicMeta,
  savePublicMeta,
  verifyHostCredentials,
  type RoomPublicMeta,
} from "@/lib/livekit";
import {
  addBan,
  addMute,
  loadAuth,
  removeBan,
  removeMember,
  removeMute,
  type RoomAuth,
} from "@/lib/roomSecret";
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
  let auth: RoomAuth | null;
  try {
    [meta, auth] = await Promise.all([loadPublicMeta(code), loadAuth(code)]);
  } catch (err) {
    console.error("load room state failed", err);
    return NextResponse.json({ error: "Сервис недоступен" }, { status: 502 });
  }
  if (!meta || !auth) {
    return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
  }

  // Авторизация. Текущий хост = тот, чей ТОКЕН совпал с hostIdentity. Один
  // мастер-ключ (byHostKey) больше НЕ даёт власти над активным хостом — права
  // отзываются при передаче (см. ниже реклейм брошенной комнаты).
  const { callerIdentity, isCurrentHost } = await verifyHostCredentials(meta, auth, {
    hostKey: body.hostKey,
    callerToken: body.callerToken,
    code,
  });

  // Реклейм/авто-передача: когда хост вышел, оставшийся участник может «занять»
  // вакантное место хоста — но только для СЕБЯ и только если текущего хоста
  // действительно нет в комнате. Единственный путь занять хоста без isCurrentHost.
  if (!isCurrentHost) {
    if (action === "transfer" && callerIdentity && target === callerIdentity) {
      const parts = await service.listParticipants(code);
      const callerPresent = parts.some((x) => x.identity === callerIdentity);
      if (callerPresent) {
        // Перечитываем metadata прямо перед записью (updateRoomMetadata — полная
        // перезапись без CAS) и занимаем хоста ТОЛЬКО если СВЕЖИЙ текущий хост
        // отсутствует — иначе параллельную передачу прав можно было бы затереть.
        const cur = await loadPublicMeta(code);
        if (cur && !parts.some((x) => x.identity === cur.hostIdentity)) {
          cur.hostIdentity = callerIdentity;
          await savePublicMeta(code, cur);
          // Новый хост не должен оставаться заглушённым (иначе вебхук вернёт мьют).
          await removeMute(code, callerIdentity).catch(() => {});
          return NextResponse.json({ ok: true });
        }
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
        // Снимаем членство: иначе кикнутый под тем же ником обошёл бы замок
        // (замок пускает «своих» из members). Для постоянного блока — бан.
        await removeMember(code, target!).catch(() => {});
        break;
      }
      case "ban": {
        await addBan(code, target!);
        // Удаляем уже зашедшего; если его нет — не страшно.
        await service.removeParticipant(code, target!).catch(() => {});
        break;
      }
      case "unban": {
        await removeBan(code, target!);
        break;
      }
      case "mute":
      case "unmute": {
        const canPublish = action === "unmute";
        // Состояние мьюта храним в Redis-сете, чтобы оно пережило
        // переподключение участника (иначе перезагрузка снимала бы мьют).
        if (canPublish) await removeMute(code, target!);
        else await addMute(code, target!);
        // Если участник сейчас в комнате — сразу применяем флаг и ограничение в
        // его metadata. Если его нет — мьют уже сохранён в Redis и применится на
        // входе (token + вебхук), поэтому это УСПЕХ, а не 404 (иначе UI показал
        // бы ошибку, хотя мьют по факту выставлен).
        const parts = await service.listParticipants(code);
        const p = parts.find((x) => x.identity === target);
        // Живой флаг/ограничение применяем единым хелпером (общим с вебхуком),
        // чтобы наборы прав при mute/unmute не разъезжались между путями.
        if (p) {
          await enforceParticipantMute(service, code, target!, p.metadata, !canPublish);
        }
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
        // Перечитываем metadata прямо перед записью, меняем ТОЛЬКО hostIdentity.
        const cur = await loadPublicMeta(code);
        if (!cur) return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
        cur.hostIdentity = target!;
        await savePublicMeta(code, cur);
        // Новый хост не должен оставаться заглушённым (вебхук вернул бы мьют).
        await removeMute(code, target!).catch(() => {});
        break;
      }
      case "lock":
      case "unlock": {
        // Перечитываем metadata прямо перед записью, меняем ТОЛЬКО locked.
        const cur = await loadPublicMeta(code);
        if (!cur) return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
        cur.locked = action === "lock";
        await savePublicMeta(code, cur);
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
