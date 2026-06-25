import type { Metadata } from "next";
import { getRoomMetaForOg } from "@/lib/ogRoomMeta";
import RoomClient from "./RoomClient";

/**
 * OG-метаданные комнаты для превью ссылок (Discord/Telegram/Slack). Название
 * берём из публичных metadata LiveKit (loadPublicMeta) — это не секрет, оно видно
 * всем участникам; доступ защищают код и пароль. Поэтому показываем название и
 * для приватных комнат: их ссылку хост шарит намеренно — в этом и смысл фичи.
 * OG-картинку явно не указываем — Next подхватит соседний opengraph-image.tsx.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const upper = code.toUpperCase();
  const meta = await getRoomMetaForOg(upper);

  if (!meta) {
    return { title: "Комната не найдена" };
  }

  const title = `Зайти в комнату «${meta.title}»`;
  const description = `Голосовая игровая комната «${meta.title}» — заходи по коду ${upper}.`;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      title,
      description,
      url: `/room/${upper}`,
    },
    // card задаём явно: twitter-объект ребёнка заменяет родительский целиком,
    // иначе summary_large_image из layout потерялся бы и стал бы summary.
    twitter: { card: "summary_large_image", title, description },
  };
}

// В Next.js 16 params — это Promise, поэтому страница асинхронная.
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <RoomClient code={code.toUpperCase()} />;
}
