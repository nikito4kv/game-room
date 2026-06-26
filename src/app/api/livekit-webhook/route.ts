import { del, list } from "@vercel/blob";
import {
  enforceParticipantMute,
  getRoomService,
  getWebhookReceiver,
  loadPublicMeta,
  parseRoomMeta,
} from "@/lib/livekit";
import { deleteRoomState, loadJoinChecks, touchTtl } from "@/lib/roomSecret";
import { cleanupStats, readStats, recordJoin } from "@/lib/analytics/roomStats";
import { captureRoomSession } from "@/lib/analytics/posthogServer";

// Вебхук LiveKit. Делает несколько вещей:
//  1. room_finished — комната опустела и удалилась → стираем загруженные карты
//     из Vercel Blob и приватное состояние комнаты из Redis; снимаем накопленную
//     статистику и шлём событие room_session в PostHog (аналитика).
//  2. participant_joined — РЕАЛЬНОЕ принуждение бана/замка/мьюта. Проверки в
//     /api/token можно обойти, переподключившись к LiveKit напрямую с ещё живым
//     токеном; здесь же мы ловим участника уже на входе и применяем правила
//     независимо от того, как он получил токен. Плюс копим статистику комнаты.
// Адреса/события этого эндпоинта нужно включить в настройках LiveKit Cloud
// (events: room_finished, participant_joined).

export async function POST(request: Request) {
  const body = await request.text();
  const authHeader = request.headers.get("Authorization") ?? undefined;

  let event;
  try {
    // receive проверяет подпись нашими ключами — чужой запрос не пройдёт.
    event = await getWebhookReceiver().receive(body, authHeader);
  } catch (err) {
    console.error("webhook auth failed", err);
    return new Response("invalid signature", { status: 401 });
  }

  if (event.event === "room_finished" && event.room?.name) {
    const code = event.room.name;
    try {
      // list пагинирован — проходим все страницы, иначе в комнате с >1 страницей
      // загрузок часть карт осталась бы навсегда.
      const prefix = `maps/${code}/`;
      const urls: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor });
        for (const b of page.blobs) urls.push(b.url);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      if (urls.length > 0) await del(urls);
    } catch (err) {
      // Не валим вебхук из-за уборки — LiveKit иначе будет ретраить.
      console.error("blob cleanup failed", err);
    }
    try {
      await deleteRoomState(code);
    } catch (err) {
      console.error("secret cleanup failed", err);
    }
    // Аналитика: снимаем накопленную статистику и шлём room_session. Длительность
    // берём из payload самого события (комнаты в LiveKit уже нет, listRooms вернул
    // бы пусто), публичность — из payload, а если metadata там нет, из значения,
    // сохранённого при входах. Ключи стираем ТОЛЬКО после успешной отправки: иначе
    // при сетевом сбое событие потерялось бы (room_finished приходит один раз).
    // Пустые комнаты (никто не зашёл) — не шлём.
    try {
      const stats = await readStats(code);
      if (stats.totalUnique >= 1) {
        const finishedAt = Number(event.createdAt ?? 0);
        const startedAt = Number(event.room.creationTime ?? 0);
        // Защита от мусора: длительность только при валидных метках времени.
        const durationSec = startedAt > 0 && finishedAt >= startedAt ? finishedAt - startedAt : 0;
        const isPublic = parseRoomMeta(event.room.metadata)?.isPublic ?? stats.isPublic;
        await captureRoomSession({
          code,
          peak: stats.peak,
          totalUnique: stats.totalUnique,
          durationSec,
          isPublic,
        });
      }
      await cleanupStats(code);
    } catch (err) {
      // Не стираем ключи при сбое отправки — они истекут по TTL, данные не теряются.
      console.error("room_session analytics failed", err);
    }
  }

  if (event.event === "participant_joined" && event.room?.name && event.participant?.identity) {
    const code = event.room.name;
    const identity = event.participant.identity;
    // Аналитика: фиксируем вход (пик по numParticipants из payload). Запускаем
    // ПАРАЛЛЕЛЬНО с модерацией и не ждём перед ней — статистика не должна
    // задерживать кик/мьют нарушителя. Ошибку проглатываем (не критичный путь).
    const statsPromise = recordJoin(
      code,
      identity,
      event.room.numParticipants ?? 0,
      parseRoomMeta(event.room.metadata)?.isPublic ?? false,
    ).catch((err) => console.error("recordJoin failed", err));
    try {
      const [meta, checks] = await Promise.all([
        loadPublicMeta(code),
        loadJoinChecks(code, identity),
      ]);
      if (checks) {
        const service = getRoomService();
        const isHost = !!meta && identity === meta.hostIdentity;
        // Бан или замок (для чужого, кто не был участником) → выкидываем сразу.
        const lockedOut = !!meta?.locked && !isHost && !checks.member;
        if (checks.banned || lockedOut) {
          await service.removeParticipant(code, identity).catch(() => {});
        } else {
          // Хоста НЕ мьютим (даже если ник остался в muted после передачи прав):
          // иначе новый хост зашёл бы заглушённым с выключенной кнопкой микрофона.
          if (!isHost && checks.muted) {
            // Заглушён хостом → восстанавливаем ограничение и флаг (общий хелпер
            // с /api/moderate; мержит metadata, не теряя isHost), даже если
            // участник зашёл со «свежим» токеном напрямую.
            await enforceParticipantMute(
              service,
              code,
              identity,
              event.participant.metadata,
              true,
            ).catch(() => {});
          }
          // Живой вход (не кик) — продлеваем TTL, чтобы состояние живой комнаты
          // не истекло на долгой сессии без модерации.
          await touchTtl(code).catch(() => {});
        }
      }
    } catch (err) {
      // Не валим вебхук — иначе LiveKit будет ретраить.
      console.error("participant_joined enforcement failed", err);
    }
    // Дожидаемся записи статистики до ответа (на serverless инстанс может
    // «замёрзнуть» после возврата). Шла параллельно модерации, так что не тормозит кик.
    await statsPromise;
  }

  return new Response("ok", { status: 200 });
}
