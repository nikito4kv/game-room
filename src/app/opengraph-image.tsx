import { ImageResponse } from "next/og";
import { loadOgFonts } from "@/lib/ogFont";
import { OG, ogContainerStyle, BrandRow } from "@/lib/ogCard";

// fs для чтения шрифтов → Node-рантайм.
export const runtime = "nodejs";

export const alt = "Game Room — голосовая игровая комната";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Дефолтная OG-карточка сайта (главная, витрина /rooms). */
export default async function Image() {
  const fonts = await loadOgFonts();

  return new ImageResponse(
    (
      <div style={{ ...ogContainerStyle, justifyContent: "center", gap: "24px" }}>
        <BrandRow />

        <div style={{ display: "flex", fontSize: "104px", fontWeight: 700, lineHeight: 1.05 }}>
          Голосовая игровая комната
        </div>
        <div style={{ display: "flex", fontSize: "40px", fontWeight: 500, color: OG.dim }}>
          Без регистрации — заходи по коду
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
