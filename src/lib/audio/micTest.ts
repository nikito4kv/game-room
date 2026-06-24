/**
 * Проверка микрофона (как «Let's Check» в Discord). Намеренно НЕ зависит от
 * LiveKit-комнаты: берёт свой getUserMedia и строит цепочку Web Audio, чтобы
 * тест работал и в настройках до входа.
 *
 *   источник → gain → analyser   (измерение уровня)
 *                   ↘ (опц.) → ctx.destination   (loopback: «слышать себя»)
 *
 * level() возвращает 0..1 (RMS по форме волны — точнее для голоса, чем спектр).
 * Обязательно вызвать stop() при закрытии — иначе останется гореть индикатор
 * микрофона ОС и не закроется AudioContext.
 */
export type MicTest = {
  level: () => number;
  setLoopback: (on: boolean) => void;
  setGain: (value: number) => void;
  stop: () => Promise<void>;
};

export async function startMicTest(
  deviceId?: string | null,
  gain = 1,
): Promise<MicTest> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  // Поток уже захвачен (горит индикатор микрофона ОС). Если что-то ниже упадёт
  // (например, ctx.resume() отклонён), обязательно освобождаем поток и контекст,
  // иначе микрофон останется гореть без возможности остановить.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
    // AudioContext может стартовать "suspended" (autoplay policy) — тест
    // запускается по клику, так что возобновление безопасно.
    if (ctx.state === "suspended") await ctx.resume();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = gain;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(gainNode).connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let loopbackOn = false;

  return {
    level() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      // RMS, слегка усиленный, чтобы тихий голос заметно двигал полоску.
      return Math.min(1, Math.sqrt(sum / data.length) * 4);
    },
    setLoopback(on: boolean) {
      if (on === loopbackOn) return;
      if (on) gainNode.connect(ctx.destination);
      else gainNode.disconnect(ctx.destination);
      loopbackOn = on;
    },
    setGain(value: number) {
      gainNode.gain.value = value;
    },
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      try {
        await ctx.close();
      } catch {
        // уже закрыт — игнорируем
      }
    },
  };
}
