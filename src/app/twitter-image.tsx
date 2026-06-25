// Та же карточка, что и для Open Graph: X использует twitter:image, остальные —
// og:image. Рендер (default) переиспользуем из opengraph-image, а конфиг сегмента
// объявляем СТАТИЧЕСКИ здесь — Next не разрешает ре-экспорт runtime/size/и т.п.
// (next build падает на ре-экспорте конфигурации).
export { default } from "./opengraph-image";

export const runtime = "nodejs";
export const alt = "Game Room — голосовая игровая комната";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
