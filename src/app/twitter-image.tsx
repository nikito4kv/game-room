// Та же карточка, что и для Open Graph: X использует twitter:image, остальные —
// og:image. Дублировать рендер незачем — ре-экспортируем opengraph-image.
export { default, alt, size, contentType, runtime } from "./opengraph-image";
