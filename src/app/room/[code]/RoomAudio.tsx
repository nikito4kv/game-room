"use client";

import { AudioTrack, StartAudio, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";

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
          <AudioTrack
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
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-emerald-500"
      />
    </>
  );
}
