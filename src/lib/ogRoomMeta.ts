import { unstable_cache } from "next/cache";
import { loadPublicMeta, type RoomPublicMeta } from "@/lib/livekit";

/**
 * Безопасное + кэшированное чтение публичных метаданных комнаты для OG-превью.
 *
 * Зачем обёртка над loadPublicMeta:
 *  • try/catch — loadPublicMeta делает сетевой listRooms() и через requireEnv
 *    может бросить (сбой LiveKit, незаданные env). В generateMetadata/opengraph-image
 *    необработанное исключение = 500. Здесь исключение → null («нет комнаты»),
 *    т.е. страница отдаёт generic-метаданные, а картинка — нейтральный вариант.
 *  • unstable_cache — один разворот ссылки краулером = ДВА HTTP-запроса (HTML
 *    страницы и OG-картинка) в разных рендерах; кэш с коротким TTL склеивает их
 *    и гасит всплески повторных разворотов, не дёргая LiveKit на каждый.
 */

// Кэшируем ТОЛЬКО успешный результат (включая легитимный null = «комнаты нет»).
// Ключ кэша зависит от аргумента code, поэтому записи не пересекаются по комнатам.
const cachedLoad = unstable_cache(
  (code: string) => loadPublicMeta(code),
  ["og-room-meta"],
  { revalidate: 60 },
);

/** Метаданные комнаты для OG. Никогда не бросает: при ошибке возвращает null. */
export async function getRoomMetaForOg(
  code: string,
): Promise<RoomPublicMeta | null> {
  try {
    // try/catch СНАРУЖИ кэша: отклонённый промис не кэшируется (unstable_cache
    // не кэширует reject), поэтому после восстановления сети следующий запрос
    // подтянет настоящее название.
    return await cachedLoad(code);
  } catch (err) {
    console.error("loadPublicMeta (OG) failed", err);
    return null;
  }
}
