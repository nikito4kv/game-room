import {
  loadRnnoise,
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";

/**
 * Шумоподавление микрофона на RNNoise (нейросеть Xiph/Mozilla, BSD) + noise gate.
 *
 *   вход → RNNoise → noise gate → выход
 *
 * RNNoise чистит постоянный шум прямо во время речи (дыхание, клавиатура, кулер,
 * фоновые голоса), а gate дорезает остатки в паузах, когда вы молчите. Всё крутится
 * в AudioWorklet (отдельный аудиопоток) — главный поток UI не блокируется. Бесплатно
 * и без сервера: ~150 КБ wasm + worklet, файлы лежат в public (см. scripts/
 * sync-noise-suppressor.mjs).
 *
 * ВАЖНО: RNNoise работает ТОЛЬКО на 48 кГц — контекст обязан быть на этой частоте
 * (см. MicProcessor, который форсит sampleRate: 48000).
 *
 * Файлы отдаются как статика, потому что worklet исполняется в своём контексте мимо
 * бандлера, а wasm грузится по URL.
 */
const BASE = "/noise-suppressor";
const RNNOISE_WORKLET_URL = `${BASE}/rnnoiseWorklet.js`;
const NOISE_GATE_WORKLET_URL = `${BASE}/noiseGateWorklet.js`;
const RNNOISE_WASM_URL = `${BASE}/rnnoise.wasm`;
const RNNOISE_WASM_SIMD_URL = `${BASE}/rnnoise_simd.wasm`;

// wasm-бинарь одинаков для всех вызовов — грузим один раз на всю вкладку.
// processorOptions передаёт его в worklet структурным клоном (не transfer), так
// что переиспользовать тот же ArrayBuffer безопасно — он не «отстёгивается».
let wasmPromise: Promise<ArrayBuffer> | null = null;
function loadWasm(): Promise<ArrayBuffer> {
  wasmPromise ??= loadRnnoise({
    url: RNNOISE_WASM_URL,
    simdUrl: RNNOISE_WASM_SIMD_URL,
  }).catch((e) => {
    // НЕ кэшируем отказ навсегда: при ?? кэшировании отклонённого промиса один
    // сетевой сбой выключил бы шумодав до перезагрузки страницы. Сбрасываем кэш,
    // чтобы следующая попытка грузила заново.
    wasmPromise = null;
    throw e;
  });
  return wasmPromise;
}

export type NoiseSuppression = {
  /** Куда подавать сырой звук. */
  input: AudioNode;
  /** Откуда забирать очищенный звук. */
  output: AudioNode;
  /** Отключить узлы и освободить wasm-инстанс RNNoise. */
  destroy: () => void;
};

/**
 * Собирает связку RNNoise → noise gate в переданном контексте (он ДОЛЖЕН быть на
 * 48 кГц). Возвращает входной и выходной узлы — наружную развязку (кто подаёт на
 * input и куда идёт output) делает вызывающий код. Внутреннее ребро RNNoise→gate
 * трогать нельзя, иначе связка развалится.
 */
export async function createNoiseSuppression(
  ctx: AudioContext,
): Promise<NoiseSuppression> {
  // RNNoise работает ТОЛЬКО на 48 кГц. Если контекст не на этой частоте (браузер
  // проигнорировал sampleRate-хинт) — отказываемся, иначе звук бы исказился.
  // Ошибку ловит MicProcessor и тихо отключает шумодав (gain продолжает работать).
  if (ctx.sampleRate !== 48000) {
    throw new Error("NoiseSuppression: требуется AudioContext на 48 кГц");
  }
  // Воркеры и wasm независимы — грузим параллельно. addModule идемпотентен в
  // рамках контекста, но контекст у нас одноразовый (см. MicProcessor).
  const [wasmBinary] = await Promise.all([
    loadWasm(),
    ctx.audioWorklet.addModule(RNNOISE_WORKLET_URL),
    ctx.audioWorklet.addModule(NOISE_GATE_WORKLET_URL),
  ]);

  // Микрофон моно — одного канала достаточно (меньше работы worklet'у).
  const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  // Пороги в дБ: открываем gate на речи (> -50), закрываем в тишине (< -60),
  // держим открытым 90 мс после спада — чтобы не «квакать» на окончаниях слов.
  const gate = new NoiseGateWorkletNode(ctx, {
    openThreshold: -50,
    closeThreshold: -60,
    holdMs: 90,
    maxChannels: 1,
  });

  rnnoise.connect(gate);

  return {
    input: rnnoise,
    output: gate,
    destroy() {
      rnnoise.disconnect();
      gate.disconnect();
      rnnoise.destroy(); // освобождает wasm-инстанс внутри worklet
    },
  };
}
