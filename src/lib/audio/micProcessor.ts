import { Track } from "livekit-client";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";
import { createNoiseSuppression, type NoiseSuppression } from "./noiseSuppressor";

/**
 * Обработка СВОЕГО микрофона перед публикацией в LiveKit. Один TrackProcessor на
 * весь конвейер (LiveKit допускает только один процессор на трек):
 *
 *   источник → [RNNoise → noise gate] → gain → выход
 *                └─ шумоподавление, опц. ─┘
 *
 * • gain — усиление входа (как Input Volume в Discord), меняется вживую.
 * • шумоподавление (RNNoise + gate) — давит дыхание/клавиатуру/фон, тоже
 *   включается/выключается вживую без переиздания трека (см. noiseSuppressor.ts).
 *
 * Контекст СВОЙ и на 48 кГц: LiveKit создаёт AudioContext на системной частоте
 * (бывает 44.1 кГц), а RNNoise работает только на 48 кГц. Поэтому opts.audioContext
 * мы игнорируем и держим собственный — заодно его проще освобождать.
 *
 * Жизненный цикл (по поведению livekit-client):
 *  • init    — первичная сборка после публикации трека;
 *  • restart — смена устройства: пересобираем узлы на новый трек, КОНТЕКСТ и уже
 *              загруженный шумодав сохраняем (не зовём destroy);
 *  • destroy — процессор снят насовсем: гасим узлы, шумодав и закрываем контекст.
 *
 * setProcessor помечен @experimental — поэтому всё изолировано в одном модуле.
 */
export class MicProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "mic-pipeline";
  processedTrack?: MediaStreamTrack;

  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private ns?: NoiseSuppression;
  // Промис идущей сборки шумодава — дедуплицирует параллельные вызовы ensureNs
  // (init + быстрый тумблер), чтобы не создать связку дважды.
  private nsPromise?: Promise<NoiseSuppression>;
  // Процессор уничтожен (вышли из комнаты). Любой «опоздавший» результат сборки
  // после этого сам себя гасит, чтобы не текли worklet-узлы.
  private disposed = false;
  private gainValue: number;
  private nsEnabled: boolean;
  /**
   * Колбэк ФАКТИЧЕСКОГО состояния шумоподавления. Процессор зовёт его, когда
   * состояние определилось авторитетно (загрузка RNNoise удалась/провалилась) —
   * чтобы UI и localStorage отражали правду, а не оптимистичный клик. Передаётся
   * конструктором (а не присваиванием поля), т.к. инстанс живёт в useState и
   * мутировать его снаружи нельзя.
   */
  private readonly onNoiseSuppressionChange?: (enabled: boolean) => void;

  constructor(
    initialGain = 1,
    initialNoiseSuppression = true,
    onNoiseSuppressionChange?: (enabled: boolean) => void,
  ) {
    this.gainValue = initialGain;
    this.nsEnabled = initialNoiseSuppression;
    this.onNoiseSuppressionChange = onNoiseSuppressionChange;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    // Свой контекст на 48 кГц (требование RNNoise). Если браузер не умеет
    // форсировать частоту (бросает) — берём дефолтный контекст БЕЗ шумодава: gain
    // продолжает работать, а не теряем весь процессор. Случай «частоту молча
    // проигнорировал» страхует проверка 48 кГц в createNoiseSuppression.
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ sampleRate: 48000 });
      } catch {
        this.ctx = new AudioContext();
        this.nsEnabled = false;
      }
    }
    const ctx = this.ctx;

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Контекст не поднялся в этом стеке (autoplay-политика) — иначе в трек
        // пойдёт ТИШИНА, а не ошибка. Добиваем по первому жесту пользователя
        // (аналог <StartAudio> на приёме, но для передачи). Слушатели одноразовые.
        const resume = () => void ctx.resume().catch(() => {});
        window.addEventListener("pointerdown", resume, { once: true });
        window.addEventListener("keydown", resume, { once: true });
      }
    }

    if (this.nsEnabled && !this.ns) {
      // Сбой загрузки wasm/worklet не должен ронять микрофон — остаёмся без
      // шумодава (флаг сбрасываем, чтобы UI показал реальное состояние).
      try {
        await this.ensureNs();
      } catch {
        this.nsEnabled = false;
      }
    }
    if (this.disposed) return; // уничтожили, пока грузился шумодав

    this.build(opts.track);
    // Сообщаем фактическое состояние: при провале загрузки оно стало false.
    this.onNoiseSuppressionChange?.(this.nsEnabled);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    // Контекст и шумодав переживают смену устройства — пересобираем только цепочку
    // на новый трек. Старые узлы отвяжутся при перезаписи в build().
    if (!this.ctx) return this.init(opts);
    this.source?.disconnect();
    this.gain?.disconnect();
    this.ns?.output.disconnect();
    this.build(opts.track);
  }

  async destroy(): Promise<void> {
    this.disposed = true; // первым делом: «опоздавший» ensureNs сам подчистится
    this.source?.disconnect();
    this.gain?.disconnect();
    this.destination?.disconnect();
    this.ns?.destroy();
    await this.ctx?.close().catch(() => {});
    this.source = undefined;
    this.gain = undefined;
    this.destination = undefined;
    this.ns = undefined;
    this.ctx = undefined;
    this.processedTrack = undefined;
  }

  /** Живое изменение усиления без переиздания трека. 1 = 100%. */
  setGain(value: number): void {
    this.gainValue = value;
    if (this.gain) this.gain.gain.value = value;
  }

  /**
   * Живое включение/выключение шумоподавления. При первом включении лениво
   * грузит RNNoise; при выключении узлы остаются (просто обходим их), чтобы
   * обратное включение было мгновенным. Возвращает фактическое состояние —
   * оно может отличаться от запрошенного, если загрузка не удалась.
   */
  async setNoiseSuppression(on: boolean): Promise<boolean> {
    this.nsEnabled = on;
    if (!this.ctx) return on; // ещё не инициализирован — применится в init()
    if (on && !this.ns) {
      try {
        await this.ensureNs();
      } catch {
        this.nsEnabled = false;
        this.onNoiseSuppressionChange?.(false);
        return false;
      }
    }
    if (this.disposed) return false;
    this.wire();
    this.onNoiseSuppressionChange?.(this.nsEnabled);
    return this.nsEnabled;
  }

  /**
   * Лениво и БЕЗ дублей создаёт связку шумоподавления. Параллельные вызовы
   * (init + быстрый тумблер) дедуплицируются через nsPromise — createNoiseSuppression
   * выполнится один раз. Если за время загрузки процессор уничтожили, готовый
   * результат гасится, чтобы не текли worklet-узлы. Ошибку загрузки пробрасывает.
   */
  private async ensureNs(): Promise<NoiseSuppression | undefined> {
    if (this.ns) return this.ns;
    const ctx = this.ctx;
    if (!ctx) return undefined;
    this.nsPromise ??= createNoiseSuppression(ctx);
    try {
      const ns = await this.nsPromise;
      if (this.disposed) {
        try {
          ns.destroy();
        } catch {
          // контекст уже закрыт — ничего страшного
        }
        return undefined;
      }
      this.ns = ns;
      return ns;
    } finally {
      this.nsPromise = undefined;
    }
  }

  /** Создаёт узлы под конкретный трек и собирает граф. */
  private build(track: MediaStreamTrack): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.gain = ctx.createGain();
    this.gain.gain.value = this.gainValue;
    this.destination = ctx.createMediaStreamDestination();
    this.wire();
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }

  /**
   * (Пере)соединяет граф под текущий флаг шумоподавления. Развязываем только
   * ВНЕШНИЕ рёбра (source→…, gate→gain, gain→destination); внутреннее ребро
   * RNNoise→gate живёт внутри NoiseSuppression и его не трогаем.
   */
  private wire(): void {
    const { source, gain, destination, ns, nsEnabled } = this;
    if (!source || !gain || !destination) return;
    source.disconnect();
    gain.disconnect();
    ns?.output.disconnect();

    if (nsEnabled && ns) {
      source.connect(ns.input);
      ns.output.connect(gain);
    } else {
      source.connect(gain);
    }
    gain.connect(destination);
  }
}
