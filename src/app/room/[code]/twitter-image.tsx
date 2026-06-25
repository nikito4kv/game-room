// Та же карточка, что и для Open Graph (X использует twitter:image). Рендер
// (default) переиспользуем, конфиг сегмента объявляем статически — Next не
// разрешает ре-экспорт runtime/size/и т.п. (next build падает на ре-экспорте).
export { default } from "./opengraph-image";

export const runtime = "nodejs";
export const alt = "Превью комнаты Game Room";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
