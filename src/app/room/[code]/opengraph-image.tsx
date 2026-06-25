import { ImageResponse } from "next/og";
import { getRoomMetaForOg } from "@/lib/ogRoomMeta";
import { loadOgFonts } from "@/lib/ogFont";
import { OG, ogContainerStyle, BrandRow } from "@/lib/ogCard";

// fs для чтения шрифтов → Node-рантайм (на edge fs недоступен).
export const runtime = "nodejs";

export const alt = "Превью комнаты Game Room";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Динамическая OG-карточка комнаты: «Зайти в комнату {название}» + код, в цветах
 * бренда. Если комнаты нет (или сбой LiveKit) — нейтральный вариант «Game Room».
 * params в Next 16 — Promise.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const upper = code.toUpperCase();
  const meta = await getRoomMetaForOg(upper);
  const fonts = await loadOgFonts();

  const title = meta?.title ?? "Game Room";
  const lead = meta ? "Зайти в комнату" : "Голосовая игровая комната";
  // Длинные названия (до 40 символов) уменьшаем, чтобы не переполнять карточку.
  const titleSize = title.length > 22 ? 64 : 92;

  return new ImageResponse(
    (
      <div style={{ ...ogContainerStyle, justifyContent: "space-between" }}>
        <BrandRow />

        {/* Центр: подводка + название */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ fontSize: "40px", fontWeight: 500, color: OG.dim }}>
            {lead}
          </div>
          <div
            style={{
              fontSize: `${titleSize}px`,
              fontWeight: 700,
              lineHeight: 1.05,
              // Не больше 2 строк: длинное название обрезается многоточием, а не
              // вылезает за карточку / на блок кода. (display:flex не клэмпит текст.)
              lineClamp: 2,
              overflow: "hidden",
              maxWidth: "1040px",
            }}
          >
            {title}
          </div>
        </div>

        {/* Низ: код комнаты (только для существующей). Используем вложенный
            flex-div, а НЕ Fragment как прямого потомка — satori не флэттит
            фрагменты, из-за чего подпись и бокс налезали друг на друга. */}
        {meta ? (
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontSize: "32px", fontWeight: 500, color: OG.dim }}>
              Код
            </div>
            <div
              style={{
                display: "flex",
                marginLeft: "20px",
                fontSize: "48px",
                fontWeight: 700,
                letterSpacing: "0.12em",
                padding: "10px 28px",
                borderRadius: "16px",
                color: OG.accent,
                border: `3px solid ${OG.accent}`,
                backgroundColor: `${OG.accent}1a`,
              }}
            >
              {upper}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: "34px", fontWeight: 500, color: OG.dim }}>
            Заходи по коду — без регистрации
          </div>
        )}
      </div>
    ),
    { ...size, fonts },
  );
}
