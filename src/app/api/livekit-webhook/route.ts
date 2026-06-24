import { del, list } from "@vercel/blob";
import { TrackSource } from "livekit-server-sdk";
import { getRoomService, getWebhookReceiver, loadPublicMeta } from "@/lib/livekit";
import { deleteSecret, loadSecret } from "@/lib/roomSecret";

// Вебхук LiveKit. Делает две вещи:
//  1. room_finished — комната опустела и удалилась → стираем загруженные карты
//     из Vercel Blob и приватное состояние комнаты из Redis.
//  2. participant_joined — РЕАЛЬНОЕ принуждение бана/замка/мьюта. Проверки в
//     /api/token можно обойти, переподключившись к LiveKit напрямую с ещё живым
//     токеном; здесь же мы ловим участника уже на входе и применяем правила
//     независимо от того, как он получил токен.
// Адреса/события этого эндпоинта нужно включить в настройках LiveKit Cloud
// (events: room_finished, participant_joined).

const SOURCES_WITHOUT_MIC = [
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

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
      await deleteSecret(code);
    } catch (err) {
      console.error("secret cleanup failed", err);
    }
  }

  if (event.event === "participant_joined" && event.room?.name && event.participant?.identity) {
    const code = event.room.name;
    const identity = event.participant.identity;
    try {
      const [meta, secret] = await Promise.all([loadPublicMeta(code), loadSecret(code)]);
      if (secret) {
        const service = getRoomService();
        const isHost = !!meta && identity === meta.hostIdentity;
        // Бан или замок (для чужого, кто не был участником) → выкидываем сразу.
        const banned = secret.banned.includes(identity);
        const lockedOut =
          !!meta?.locked && !isHost && !secret.members.includes(identity);
        if (banned || lockedOut) {
          await service.removeParticipant(code, identity).catch(() => {});
        } else if (secret.mutedIdentities.includes(identity)) {
          // Заглушён хостом → восстанавливаем ограничение и флаг, даже если
          // участник зашёл со «свежим» токеном напрямую.
          await service
            .updateParticipant(code, identity, JSON.stringify({ forceMuted: true }), {
              canSubscribe: true,
              canPublish: true,
              canPublishData: true,
              canPublishSources: SOURCES_WITHOUT_MIC,
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      // Не валим вебхук — иначе LiveKit будет ретраить.
      console.error("participant_joined enforcement failed", err);
    }
  }

  return new Response("ok", { status: 200 });
}
