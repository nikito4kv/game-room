// Копирует рантайм-файлы RNNoise и noise-gate из пакета @sapphi-red/web-noise-
// suppressor в public/, чтобы Next.js отдавал их как обычную статику.
//
// Почему не импорт: worklet-файлы исполняются в ОТДЕЛЬНОМ AudioWorklet-контексте
// (мимо бандлера), а wasm подгружается по URL через fetch. И то и другое должно
// лежать в public и грузиться по абсолютному пути, а не проходить через webpack.
//
// Запускается перед `dev` и `build` (см. package.json), поэтому версия файлов в
// public всегда совпадает с установленным пакетом — а сами файлы не коммитим
// (см. .gitignore), чтобы не тащить ~460 КБ бинарей в репозиторий.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const dest = join(root, "public", "noise-suppressor");

// [откуда в пакете, как назвать в public]
const files = [
  ["rnnoise.wasm", "rnnoise.wasm"],
  ["rnnoise_simd.wasm", "rnnoise_simd.wasm"],
  ["rnnoise/workletProcessor.js", "rnnoiseWorklet.js"],
  ["noiseGate/workletProcessor.js", "noiseGateWorklet.js"],
];

await mkdir(dest, { recursive: true });
await Promise.all(files.map(([from, to]) => copyFile(join(src, from), join(dest, to))));
console.log(`[noise-suppressor] синхронизировано файлов: ${files.length} → public/noise-suppressor`);
