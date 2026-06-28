// Встроенная библиотека карт. Старт — CS2. Чтобы добавить другую игру,
// заведи ещё один такой массив; формат тот же.
//
// src — корне-относительный путь к радару в public/ (проходит BUILTIN_MAP_RE в
// board.ts). Радары CS2 квадратные, поэтому aspect = 1: рамка знает пропорции
// заранее, без скачка вёрстки при загрузке картинки.

export type GameMap = { id: string; name: string; src: string; aspect: number };

export const CS2_MAPS: GameMap[] = [
  { id: "mirage", name: "Mirage", src: "/maps/cs2/mirage.jpg", aspect: 1 },
  { id: "dust2", name: "Dust II", src: "/maps/cs2/dust2.jpg", aspect: 1 },
  { id: "inferno", name: "Inferno", src: "/maps/cs2/inferno.jpg", aspect: 1 },
  { id: "nuke", name: "Nuke", src: "/maps/cs2/nuke.jpg", aspect: 1 },
  { id: "overpass", name: "Overpass", src: "/maps/cs2/overpass.jpg", aspect: 1 },
  { id: "ancient", name: "Ancient", src: "/maps/cs2/ancient.jpg", aspect: 1 },
  { id: "anubis", name: "Anubis", src: "/maps/cs2/anubis.jpg", aspect: 1 },
  { id: "vertigo", name: "Vertigo", src: "/maps/cs2/vertigo.jpg", aspect: 1 },
  { id: "train", name: "Train", src: "/maps/cs2/train.jpg", aspect: 1 },
];
