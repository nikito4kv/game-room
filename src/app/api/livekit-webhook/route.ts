import { del, list } from "@vercel/blob";
import { getWebhookReceiver } from "@/lib/livekit";

// Вебхук LiveKit: когда комната опустела и удалилась (room_finished), стираем
// загруженные для неё фон-карты из Vercel Blob — чтобы файлы не копились.
// Адрес этого эндпоинта нужно прописать в настройках проекта LiveKit Cloud.

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
    try {
      // list пагинирован — проходим все страницы, иначе в комнате с >1 страницей
      // загрузок часть карт осталась бы навсегда.
      const prefix = `maps/${event.room.name}/`;
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
  }

  return new Response("ok", { status: 200 });
}
