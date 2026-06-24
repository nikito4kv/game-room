import { Track } from "livekit-client";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";

/**
 * Усиление своего микрофона (как Input Volume в Discord). В браузере нет
 * нативного gain на getUserMedia, поэтому вставляем GainNode в цепочку
 * Web Audio: источник → gain → выход, а обработанный трек публикуем в LiveKit.
 *
 * AudioContext нам даёт сам LiveKit через opts.audioContext (трек уже получен
 * после жеста пользователя, отдельная разблокировка не нужна). Менять громкость
 * можно вживую через setGain() — переиздавать трек НЕ требуется.
 *
 * Помечен @experimental в SDK — поэтому изолирован в одном модуле.
 */
export class GainProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "input-gain";
  processedTrack?: MediaStreamTrack;

  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private value: number;

  constructor(initialGain = 1) {
    this.value = initialGain;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    // LiveKit передаёт audioContext только в первый init. При смене устройства
    // он зовёт restart() БЕЗ audioContext — переиспользуем сохранённый, иначе
    // ctx.createMediaStreamSource упал бы на undefined и сломал бы микрофон.
    const ctx = opts.audioContext ?? this.ctx;
    if (!ctx) throw new Error("GainProcessor: нет AudioContext");
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.gain = ctx.createGain();
    this.gain.gain.value = this.value;
    this.destination = ctx.createMediaStreamDestination();
    this.source.connect(this.gain).connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.destination?.disconnect();
    this.source = undefined;
    this.gain = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
  }

  /** Живое изменение усиления без переиздания трека. 1 = 100%. */
  setGain(value: number): void {
    this.value = value;
    if (this.gain) this.gain.gain.value = value;
  }
}
