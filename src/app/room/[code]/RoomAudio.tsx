"use client";

import { AudioTrack, StartAudio, useTracks } from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useState } from "react";

/**
 * Через сколько мс после появления чужого трека принудительно пере-монтировать
 * <AudioTrack>. Лечит баг «новый участник слышен только в левое ухо».
 *
 * Почему так: при webAudioMix LiveKit гонит звук через Web Audio граф и в момент
 * attach() создаёт createMediaStreamSource(stream). Если поток ещё «холодный»
 * (RTP-пакеты не пошли, канальная раскладка не устаканилась), Chromium залипает
 * на одном канале — звук уходит только в левый. Перезаход лечил, потому что трек
 * переподключался над «прогретым» потоком. Мы воспроизводим это автоматически:
 * один раз пере-монтируем <AudioTrack> (unmount→detach, mount→attach), и
 * connectWebAudio пересоздаёт sourceNode уже над живым потоком. Задержка должна
 * с запасом перекрывать прибытие первых аудио-пакетов.
 */
const WEBAUDIO_REWARM_MS = 700;

/**
 * Ручной рендер чужого звука вместо <RoomAudioRenderer>. Нужен, чтобы крутить
 * громкость КАЖДОМУ участнику отдельно (через проп `volume` у <AudioTrack>),
 * чего штатный рендерер не умеет.
 *
 * Громкость: deafened (заглушить всех) — через `muted` (сервер перестаёт слать
 * звук, экономит трафик). Персональный «заглушить для себя» — через volume=0, а
 * НЕ `muted`: так подписка на трек остаётся живой и индикатор «говорит» у этого
 * участника продолжает работать. Громкость >1 (буст до 200%) работает только при
 * webAudioMix (включён в <LiveKitRoom options>), иначе HTMLMediaElement.volume
 * упал бы на значении больше 1.
 *
 * <StartAudio> обязателен: без штатного рендерера autoplay-разблокировку звука
 * нужно делать самим, иначе Chrome/Safari молчат до первого клика.
 */
export default function RoomAudio({
  deafened,
  masterVolume,
  volumes,
  mutes,
}: {
  deafened: boolean;
  masterVolume: number;
  volumes: Record<string, number>;
  mutes: Record<string, boolean>;
}) {
  // Микрофоны и звук демонстраций экрана; только подписанные и только чужие
  // (свой голос себе не воспроизводим).
  const tracks = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio],
    { onlySubscribed: true },
  ).filter((t) => !t.participant.isLocal);

  return (
    <>
      {tracks.map((t) => {
        const id = t.participant.identity;
        const raw = masterVolume * (volumes[id] ?? 1);
        // Защита от мусора в localStorage (NaN/отрицательное) и персональный мьют.
        const volume = mutes[id] ? 0 : Number.isFinite(raw) ? Math.max(0, raw) : 1;
        return (
          <RewarmingAudioTrack
            key={t.publication.trackSid}
            trackRef={t}
            volume={volume}
            muted={deafened}
          />
        );
      })}
      {/* Кнопка видна, только если браузер заблокировал автозвук; кликнул —
          и она сама прячется. */}
      <StartAudio
        label="🔊 Нажмите, чтобы включить звук"
        className="btn btn--live fixed bottom-4 left-1/2 z-[var(--z-notify)] -translate-x-1/2 shadow-[var(--shadow-2)]"
      />
    </>
  );
}

/**
 * <AudioTrack> с одноразовым «прогревочным» пере-монтированием. Меняем внутренний
 * key один раз через WEBAUDIO_REWARM_MS — React пересоздаёт <AudioTrack>, тот
 * делает detach→attach, и LiveKit пересобирает Web Audio граф над уже живым
 * потоком (см. WEBAUDIO_REWARM_MS). Внешний key (trackSid) стабилен, поэтому
 * прогрев срабатывает ровно раз на каждый новый трек.
 */
function RewarmingAudioTrack({
  trackRef,
  volume,
  muted,
}: {
  trackRef: TrackReference;
  volume: number;
  muted: boolean;
}) {
  const [rewarm, setRewarm] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setRewarm(1), WEBAUDIO_REWARM_MS);
    return () => clearTimeout(id);
  }, []);
  return (
    <AudioTrack key={rewarm} trackRef={trackRef} volume={volume} muted={muted} />
  );
}
