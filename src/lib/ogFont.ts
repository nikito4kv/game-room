import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Загрузка кириллических шрифтов для OG-картинок (ImageResponse/satori).
 *
 * Стандартный шрифт ImageResponse не содержит кириллицу → текст превратился бы
 * в «тофу». next/font/google тут не подходит (его кэш в .next не отдаёт сырой
 * ArrayBuffer), поэтому держим статические инстансы Exo 2 в assets/ от корня
 * проекта и читаем их через fs (отсюда runtime = "nodejs" в image-роутах).
 *
 * Файлы созданы инстансированием вариативного Exo2[wght] (см. assets/).
 */
export type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600 | 700;
  style: "normal";
};

/** Читает один статический вес Exo 2 из assets/. */
async function load(file: string, weight: OgFont["weight"]): Promise<OgFont> {
  const data = await readFile(join(process.cwd(), "assets", file));
  return { name: "Exo 2", data, weight, style: "normal" };
}

/**
 * Шрифты для ImageResponse: Medium (подписи/тело) + Bold (заголовки, название
 * комнаты). Возвращаем массив в формате, который ждёт опция `fonts`.
 */
export async function loadOgFonts(): Promise<OgFont[]> {
  return Promise.all([
    load("Exo2-Medium.ttf", 500),
    load("Exo2-Bold.ttf", 700),
  ]);
}
