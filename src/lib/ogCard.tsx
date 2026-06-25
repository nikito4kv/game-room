/**
 * Общие строительные блоки OG-карточек (ImageResponse/satori). Вынесены, чтобы
 * цвета бренда и бренд-строка не дублировались между корневой и комнатной
 * картинками. Модуль серверный (без "use client") — это элементы для next/og.
 */

// Цвета из дизайн-системы (design-system/tokens.css, скин Arena).
export const OG = {
  bg: "#0b0f17",
  accent: "#6e66ff",
  live: "#1fd888",
  text: "#e9eef7",
  dim: "#9eacc2",
} as const;

/**
 * Базовый стиль контейнера карточки: тёмный фон + акцентное свечение из верхнего-
 * левого угла + шрифт/цвет текста. justifyContent/gap каждая карточка задаёт сама.
 */
export const ogContainerStyle = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  padding: "80px",
  backgroundColor: OG.bg,
  backgroundImage: `radial-gradient(900px circle at 12% 0%, ${OG.accent}33, transparent 55%)`,
  fontFamily: "Exo 2",
  color: OG.text,
} as const;

/** Бренд-строка: индикатор live + лейбл «GAME ROOM». */
export function BrandRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
      <div
        style={{
          width: "18px",
          height: "18px",
          borderRadius: "9999px",
          backgroundColor: OG.live,
        }}
      />
      <div
        style={{
          fontSize: "30px",
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: OG.dim,
        }}
      >
        GAME ROOM
      </div>
    </div>
  );
}
