"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  ParticipantName,
  useConnectionState,
  useIsSpeaking,
  useLocalParticipant,
  useParticipantInfo,
  useParticipants,
  useRoomContext,
  useRoomInfo,
  useTracks,
  useTrackToggle,
  VideoTrack,
  type TrackReference,
} from "@livekit/components-react";
import {
  ConnectionState,
  DisconnectReason,
  type LocalAudioTrack,
  MediaDeviceFailure,
  Participant,
  RoomEvent,
  Track,
} from "livekit-client";
import { moderate, type ModerationAction } from "@/lib/moderation";
import {
  clearPassword,
  getHostKey,
  getInputDevice,
  getInputGain,
  getMasterVolume,
  getOutputDevice,
  getNickname,
  getParticipantMutes,
  getParticipantVolumes,
  setInputGain,
  setMasterVolume,
  setNickname as saveNickname,
  setParticipantMute,
  setParticipantVolume,
  takePassword,
} from "@/lib/clientStorage";
import { GainProcessor } from "@/lib/audio/gainProcessor";
import RoomAudio from "./RoomAudio";
import SettingsModal from "./SettingsModal";
import TacticsBoard from "./TacticsBoard";
import Banner from "@/components/Banner";

type JoinInfo = { token: string; serverUrl: string; title: string; isHost: boolean };

// webAudioMix пускает приём звука через общий AudioContext. Это нужно, чтобы
// громкость участника можно было поднимать ВЫШE 100% (через gain), иначе LiveKit
// выставляет HTMLMediaElement.volume напрямую и значение >1 роняет ошибку.
// Объект вынесен из компонента — стабильная ссылка, чтобы Room не пересоздавался.
const ROOM_OPTIONS = { webAudioMix: true } as const;

export default function RoomClient({ code }: { code: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState<string | null>(null);
  const [nickInput, setNickInput] = useState("");
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // «Заглушить всех» — управляет приёмом чужого аудио. Живёт здесь, потому что
  // <RoomAudio> рендерится на этом уровне, а кнопка — внутри RoomView.
  const [deafened, setDeafened] = useState(false);
  // Нет доступа к микрофону: не вылетаем, а пускаем слушателем (см. план).
  const [micDenied, setMicDenied] = useState(false);
  // Аудио-настройки «для себя» (Этап 5a). Дефолты для SSR; реальные значения
  // подтягиваем из localStorage после монтирования. Персональные громкости и
  // муты участников — карты «ник → значение».
  const [masterVolume, setMasterVolumeState] = useState(1);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [mutes, setMutes] = useState<Record<string, boolean>>({});

  // Подтягиваем сохранённый ник. localStorage недоступен при SSR, поэтому
  // читаем его один раз после монтирования (эффект здесь оправдан).
  useEffect(() => {
    const saved = getNickname();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    if (saved) setNickname(saved);
  }, []);

  // Одноразовое чтение аудио-настроек из localStorage (после монтирования).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- одноразовое чтение localStorage */
    setMasterVolumeState(getMasterVolume());
    setVolumes(getParticipantVolumes());
    setMutes(getParticipantMutes());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Сеттеры: меняем state и сразу персистим. Дефолты из карт чистит storage.
  const changeMasterVolume = useCallback((v: number) => {
    setMasterVolumeState(v);
    setMasterVolume(v);
  }, []);
  const changeParticipantVolume = useCallback((identity: string, v: number) => {
    setVolumes((prev) => ({ ...prev, [identity]: v }));
    setParticipantVolume(identity, v);
  }, []);
  const changeParticipantMute = useCallback((identity: string, muted: boolean) => {
    setMutes((prev) => ({ ...prev, [identity]: muted }));
    setParticipantMute(identity, muted);
  }, []);

  const requestToken = useCallback(
    async (nick: string) => {
      const password = takePassword(code);
      const hostKey = getHostKey(code);
      try {
        const res = await fetch("/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, nickname: nick, password, hostKey }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Не удалось войти в комнату");
          return;
        }
        // Пароль больше не нужен — стираем, чтобы не лежал в sessionStorage.
        clearPassword(code);
        setJoin(data as JoinInfo);
      } catch {
        setError("Сеть недоступна. Попробуйте ещё раз.");
      }
    },
    [code],
  );

  // Как только знаем ник — запрашиваем токен (загрузка данных при монтировании).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- асинхронная загрузка токена
    if (nickname && !join) void requestToken(nickname);
  }, [nickname, join, requestToken]);

  function handleNickSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nick = nickInput.trim();
    if (!nick) return;
    saveNickname(nick);
    setNickname(nick);
  }

  // Нет ника (зашли по прямой ссылке) — спросим его.
  if (!nickname) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <form onSubmit={handleNickSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-zinc-500">Введите ник, чтобы войти.</p>
          <input
            value={nickInput}
            onChange={(e) => setNickInput(e.target.value)}
            placeholder="Ник"
            maxLength={24}
            autoFocus
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
          >
            Войти
          </button>
        </form>
      </CenteredCard>
    );
  }

  if (error) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <Banner tone="error">{error}</Banner>
        <button
          onClick={() => router.push("/")}
          className="rounded-md border border-zinc-300 px-4 py-2 dark:border-zinc-700"
        >
          На главную
        </button>
      </CenteredCard>
    );
  }

  if (!join) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <p className="text-sm text-zinc-500">Подключаемся…</p>
      </CenteredCard>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={join.serverUrl}
      token={join.token}
      connect
      options={ROOM_OPTIONS}
      // Этап 2: микрофон публикуем при входе (живой). Камеру — нет.
      audio={true}
      video={false}
      // Ошибки устройств (нет доступа к микрофону) НЕ роняем на экран ошибки:
      // их ловит onMediaDeviceFailure и оставляет нас слушателем. Иначе при
      // отказе микрофона onError перекрыл бы баннер полноэкранной ошибкой.
      onError={(e) => {
        if (MediaDeviceFailure.getFailure(e)) return;
        setError(e.message);
      }}
      onMediaDeviceFailure={() => setMicDenied(true)}
      className="flex flex-1 flex-col"
    >
      <RoomAudio
        deafened={deafened}
        masterVolume={masterVolume}
        volumes={volumes}
        mutes={mutes}
      />
      <RoomView
        code={code}
        title={join.title}
        token={join.token}
        onLeave={() => router.push("/")}
        deafened={deafened}
        onToggleDeafen={() => setDeafened((v) => !v)}
        micDenied={micDenied}
        onMicDenied={() => setMicDenied(true)}
        onMicOk={() => setMicDenied(false)}
        masterVolume={masterVolume}
        onChangeMasterVolume={changeMasterVolume}
        volumes={volumes}
        mutes={mutes}
        onChangeParticipantVolume={changeParticipantVolume}
        onChangeParticipantMute={changeParticipantMute}
      />
    </LiveKitRoom>
  );
}

/** Внутренний вид комнаты — имеет доступ к контексту LiveKit. */
function RoomView({
  code,
  title,
  token,
  onLeave,
  deafened,
  onToggleDeafen,
  micDenied,
  onMicDenied,
  onMicOk,
  masterVolume,
  onChangeMasterVolume,
  volumes,
  mutes,
  onChangeParticipantVolume,
  onChangeParticipantMute,
}: {
  code: string;
  title: string;
  token: string;
  onLeave: () => void;
  deafened: boolean;
  onToggleDeafen: () => void;
  micDenied: boolean;
  onMicDenied: () => void;
  onMicOk: () => void;
  masterVolume: number;
  onChangeMasterVolume: (v: number) => void;
  volumes: Record<string, number>;
  mutes: Record<string, boolean>;
  onChangeParticipantVolume: (identity: string, v: number) => void;
  onChangeParticipantMute: (identity: string, muted: boolean) => void;
}) {
  const participants = useParticipants();
  const state = useConnectionState();
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

  // --- Этап 5: модерация хоста ---
  // Кто хост — берём из метаданных комнаты (реактивно), а не из токена: так
  // передача прав видна всем сразу, а не только при следующем входе.
  const roomInfo = useRoomInfo();
  const roomMeta = useMemo(() => {
    if (!roomInfo.metadata) return null;
    try {
      return JSON.parse(roomInfo.metadata) as {
        hostIdentity?: string;
        locked?: boolean;
      };
    } catch {
      return null;
    }
  }, [roomInfo.metadata]);
  const hostIdentity = roomMeta?.hostIdentity ?? null;
  const locked = !!roomMeta?.locked;
  const amHost = !!hostIdentity && hostIdentity === localParticipant.identity;
  // Создатель держит секрет хоста в localStorage — даже если права куда-то ушли,
  // он может вернуть их себе (см. кнопку «Вернуть права»).
  const [hasHostKey, setHasHostKey] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    setHasHostKey(!!getHostKey(code));
  }, [code]);

  const [modError, setModError] = useState<string | null>(null);
  const doModerate = useCallback(
    async (action: ModerationAction, target?: string) => {
      setModError(null);
      const r = await moderate(code, token, action, target);
      if (!r.ok) setModError(r.error ?? "Не удалось выполнить действие");
    },
    [code, token],
  );

  // Меня жёстко заглушил хост. Берём флаг из своих же метаданных участника
  // (canPublish остаётся true — глушится только источник «микрофон»).
  const localInfo = useParticipantInfo({ participant: localParticipant });
  const forceMutedMe = useMemo(() => {
    if (!localInfo.metadata) return false;
    try {
      return !!(JSON.parse(localInfo.metadata) as { forceMuted?: boolean }).forceMuted;
    } catch {
      return false;
    }
  }, [localInfo.metadata]);

  // Меня удалили (кик/бан) — отличаем от обычного обрыва, чтобы показать причину.
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    const onDisconnected = (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) setRemoved(true);
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // Авто-передача прав: если хоста нет среди подключённых — оставшиеся
  // детерминированно выбирают нового (самый ранний по входу; тай-брейк по нику),
  // и победитель «занимает» вакантное место. Запрос шлёт только он — без гонки.
  const claimingRef = useRef(false);
  // Видели ли мы хоста в комнате хотя бы раз за сессию. Нужно, чтобы не
  // «перехватить» права, пока хост ещё только подключается (он мог создать
  // комнату на доли секунды позже нас).
  const hostSeenRef = useRef(false);
  // Подстраховка: если хоста так и не видно дольше grace-периода, разрешаем
  // занять вакантное место (комната могла остаться без хоста до нашего входа).
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (state !== ConnectionState.Connected) return;
    const t = setTimeout(() => setGraceOver(true), 5000);
    return () => clearTimeout(t);
  }, [state]);
  useEffect(() => {
    if (!hostIdentity || participants.length === 0) return;
    if (participants.some((p) => p.identity === hostIdentity)) {
      hostSeenRef.current = true;
      return;
    }
    // Хоста нет. Не перехватываем сразу: вдруг он ещё подключается.
    if (!hostSeenRef.current && !graceOver) return;
    const winner = [...participants].sort((a, b) => {
      const ja = a.joinedAt?.getTime() ?? 0;
      const jb = b.joinedAt?.getTime() ?? 0;
      if (ja !== jb) return ja - jb;
      return a.identity < b.identity ? -1 : 1;
    })[0];
    if (winner.identity !== localParticipant.identity || claimingRef.current) return;
    claimingRef.current = true;
    void moderate(code, token, "transfer", localParticipant.identity).finally(() => {
      claimingRef.current = false;
    });
  }, [participants, hostIdentity, localParticipant.identity, graceOver, code, token]);

  // Применяем сохранённые устройства один раз после подключения. Без exact —
  // если устройства уже нет, LiveKit спокойно падает на системное по умолчанию.
  const appliedDevicesRef = useRef(false);
  useEffect(() => {
    if (state !== ConnectionState.Connected || appliedDevicesRef.current) return;
    appliedDevicesRef.current = true;
    const inId = getInputDevice();
    const outId = getOutputDevice();
    if (inId) void room.switchActiveDevice("audioinput", inId).catch(() => {});
    if (outId) void room.switchActiveDevice("audiooutput", outId).catch(() => {});
  }, [state, room]);
  // Кнопка своего микрофона. onDeviceError ловит отказ при ручном включении.
  const mic = useTrackToggle({
    source: Track.Source.Microphone,
    onDeviceError: onMicDenied,
  });
  // Микрофон включился — баннер «нет доступа» больше не нужен.
  useEffect(() => {
    if (mic.enabled) onMicOk();
  }, [mic.enabled, onMicOk]);

  // Окно настроек звука (шестерёнка в шапке).
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Усиление своего микрофона. Процессор создаём один раз (ленивый init), меняем
  // gain вживую без переиздания трека.
  const [inputGain, setInputGainState] = useState(1);
  const [gainProcessor] = useState(() => new GainProcessor(getInputGain()));
  // Какой именно микрофон-трек уже обработан — чтобы не вешать процессор дважды.
  const processedSidRef = useRef<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    setInputGainState(getInputGain());
  }, []);

  const changeInputGain = useCallback(
    (v: number) => {
      setInputGainState(v);
      setInputGain(v);
      gainProcessor.setGain(v);
    },
    [gainProcessor],
  );

  // Навешиваем GainProcessor на локальный микрофон после публикации. Идемпотентно
  // через processedSidRef (повторная публикация / dev StrictMode не дублируют).
  useEffect(() => {
    if (!mic.enabled) return;
    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack as LocalAudioTrack | undefined;
    if (!track || !pub) return;
    if (processedSidRef.current === pub.trackSid) return;
    processedSidRef.current = pub.trackSid;
    gainProcessor.setGain(inputGain);
    void track.setProcessor(gainProcessor).catch(() => {
      // setProcessor @experimental — при сбое остаёмся на «чистом» микрофоне
      processedSidRef.current = null;
    });
  }, [mic.enabled, localParticipant, inputGain, gainProcessor]);
  // Кнопка демонстрации экрана. Звук вкладки/системы захватываем вместе с
  // картинкой (audio: true) — браузер сам покажет галочку «поделиться звуком».
  const [screenError, setScreenError] = useState(false);
  const screen = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true },
    // Отмена в системном окне выбора экрана прилетает сюда — не роняем комнату,
    // показываем мягкий баннер (как с микрофоном).
    onDeviceError: () => setScreenError(true),
  });
  // Все активные демонстрации экрана в комнате (свои и чужие).
  const screens = useTracks([Track.Source.ScreenShare]);
  // Что показываем в центре: демонстрацию экрана или доску. Оба блока остаются
  // смонтированными (неактивный прячем через CSS) — доска при этом продолжает
  // принимать чужие рисунки в фоне и не теряет накопленное.
  const [stage, setStage] = useState<"screen" | "board">("screen");
  // Запоминаем факт успешного подключения, чтобы отличить «потеряли связь» от
  // обычного начального состояния и от пересоздания компонента в dev (StrictMode).
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- латчим однократно факт подключения
    if (state === ConnectionState.Connected) setEverConnected(true);
  }, [state]);

  // Хост удалил нас из комнаты — отдельный экран с понятной причиной.
  if (removed) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-xl font-bold">Вас удалили из комнаты</h1>
        <p className="text-sm text-zinc-500">Хост удалил вас из этой комнаты.</p>
        <button
          onClick={onLeave}
          className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
        >
          На главную
        </button>
      </main>
    );
  }

  // Терминальный обрыв (после того как были на связи) — показываем экран, а не
  // молча выкидываем на главную. Кратковременные обрывы LiveKit чинит сам.
  if (everConnected && state === ConnectionState.Disconnected) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-xl font-bold">Соединение потеряно</h1>
        <p className="text-sm text-zinc-500">Связь с комнатой прервалась.</p>
        <button
          onClick={onLeave}
          className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
        >
          На главную
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-zinc-500">
            Код: <span className="font-mono font-semibold">{code}</span> · {statusLabel(state)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {amHost && (
            <button
              onClick={() => void doModerate(locked ? "unlock" : "lock")}
              title={
                locked
                  ? "Открыть комнату для новых участников"
                  : "Закрыть комнату для новых участников"
              }
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:hover:bg-zinc-800 hover:bg-zinc-100"
            >
              {locked ? "🔓 Открыть комнату" : "🔒 Закрыть комнату"}
            </button>
          )}
          {!amHost && hasHostKey && (
            <button
              onClick={() => void doModerate("transfer", localParticipant.identity)}
              title="Вы создатель комнаты — вернуть себе права хоста"
              className="rounded-md border border-amber-400 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/30"
            >
              👑 Вернуть права
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            title="Настройки звука"
            aria-label="Настройки звука"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:hover:bg-zinc-800 hover:bg-zinc-100"
          >
            ⚙️ Настройки
          </button>
          <button
            onClick={onLeave}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Выйти
          </button>
        </div>
      </header>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          masterVolume={masterVolume}
          onChangeMasterVolume={onChangeMasterVolume}
          inputGain={inputGain}
          onChangeInputGain={changeInputGain}
        />
      )}

      {state === ConnectionState.Reconnecting && (
        <Banner tone="warn">Связь прервалась, переподключаемся…</Banner>
      )}

      {micDenied && (
        <Banner tone="warn">
          Нет доступа к микрофону — вас не слышно. Разрешите доступ в адресной
          строке браузера и нажмите «Включить микрофон».
        </Banner>
      )}

      {screenError && (
        <Banner tone="warn">
          Демонстрация экрана не запустилась. Возможно, вы закрыли окно выбора —
          нажмите «Показать экран» ещё раз.
        </Banner>
      )}

      {forceMutedMe && (
        <Banner tone="warn">
          Хост заглушил ваш микрофон. Включить его снова сможет только хост.
        </Banner>
      )}

      {modError && <Banner tone="error">{modError}</Banner>}

      <section className="flex flex-wrap gap-2">
        <button
          onClick={() => void mic.toggle()}
          disabled={mic.pending || forceMutedMe}
          title={forceMutedMe ? "Микрофон заглушён хостом" : undefined}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {mic.enabled ? "🎙 Выключить микрофон" : "🔇 Включить микрофон"}
        </button>
        <button
          onClick={onToggleDeafen}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {deafened ? "🔊 Включить звук" : "🔈 Заглушить всех"}
        </button>
        <button
          onClick={() => {
            setScreenError(false);
            void screen.toggle();
          }}
          disabled={screen.pending}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {screen.enabled ? "⏹ Остановить показ" : "🖥 Показать экран"}
        </button>
      </section>

      <div className="flex gap-2">
        <StageTab active={stage === "screen"} onClick={() => setStage("screen")}>
          🖥 Экран
        </StageTab>
        <StageTab active={stage === "board"} onClick={() => setStage("board")}>
          ✏️ Доска
        </StageTab>
      </div>

      {/* Оба блока смонтированы; неактивный скрыт через hidden. */}
      <div className={stage === "screen" ? "" : "hidden"}>
        <ScreenShareStage screens={screens} />
      </div>
      <div className={stage === "board" ? "" : "hidden"}>
        <TacticsBoard code={code} active={stage === "board"} token={token} amHost={amHost} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-500">
          Участники ({participants.length})
        </h2>
        <ul className="flex flex-col gap-1">
          {participants.map((p) => (
            <ParticipantRow
              key={p.identity}
              p={p}
              isHost={p.identity === hostIdentity}
              amHost={amHost}
              volume={volumes[p.identity] ?? 1}
              muted={!!mutes[p.identity]}
              onChangeVolume={(v) => onChangeParticipantVolume(p.identity, v)}
              onToggleMute={() => onChangeParticipantMute(p.identity, !mutes[p.identity])}
              onModerate={doModerate}
            />
          ))}
        </ul>
      </section>
    </main>
  );
}

/**
 * Область демонстрации экрана: выбранный поток крупно («spotlight»), а если
 * показывают несколько — полоса превью снизу, клик по превью разворачивает.
 * Своя демонстрация тоже попадает сюда — это подтверждение, что показ идёт.
 */
function ScreenShareStage({ screens }: { screens: TrackReference[] }) {
  // Какой поток развёрнут крупно. Это лишь предпочтение: если выбранного потока
  // уже нет в списке, фокус «падает» на последний появившийся (см. ниже) —
  // отдельная синхронизация состояния не нужна.
  const [focusedSid, setFocusedSid] = useState<string | null>(null);

  if (screens.length === 0) {
    return (
      <section className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        Никто не показывает экран
      </section>
    );
  }

  const focused =
    screens.find((s) => s.publication.trackSid === focusedSid) ??
    screens[screens.length - 1];

  return (
    <section className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-zinc-800">
        <VideoTrack trackRef={focused} className="aspect-video w-full object-contain" />
        <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
          <ParticipantName participant={focused.participant} />
          {focused.participant.isLocal && " (вы)"}
        </span>
      </div>

      {screens.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {screens.map((s) => {
            const sid = s.publication.trackSid;
            const active = sid === focused.publication.trackSid;
            return (
              <button
                key={sid}
                onClick={() => setFocusedSid(sid)}
                className={
                  "relative w-40 overflow-hidden rounded-md border bg-black transition-colors " +
                  (active
                    ? "border-emerald-500 ring-1 ring-emerald-500"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800")
                }
              >
                <VideoTrack trackRef={s} className="aspect-video w-full object-contain" />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  <ParticipantName participant={s.participant} />
                  {s.participant.isLocal && " (вы)"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Вкладка переключателя «Экран / Доска» над центральной областью. */
function StageTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md border px-4 py-1.5 text-sm font-medium transition-colors " +
        (active
          ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800")
      }
    >
      {children}
    </button>
  );
}

/**
 * Строка участника: индикация говорящего, значок «в муте», а для ЧУЖИХ —
 * персональный ползунок громкости (0–200%) и кнопка «заглушить для меня».
 * Настройки громкости — локальные «для себя», другим участникам не видны.
 */
function ParticipantRow({
  p,
  isHost,
  amHost,
  volume,
  muted,
  onChangeVolume,
  onToggleMute,
  onModerate,
}: {
  p: Participant;
  isHost: boolean;
  amHost: boolean;
  volume: number;
  muted: boolean;
  onChangeVolume: (v: number) => void;
  onToggleMute: () => void;
  onModerate: (action: ModerationAction, target?: string) => void;
}) {
  const isSpeaking = useIsSpeaking(p);
  const micMuted = !p.isMicrophoneEnabled;
  // Реактивные метаданные участника: флаг «заглушён хостом» (forceMuted).
  const info = useParticipantInfo({ participant: p });
  const forceMuted = useMemo(() => {
    if (!info.metadata) return false;
    try {
      return !!(JSON.parse(info.metadata) as { forceMuted?: boolean }).forceMuted;
    } catch {
      return false;
    }
  }, [info.metadata]);
  // Кнопки хоста показываем только хосту и только для ЧУЖИХ участников.
  const showHostControls = amHost && !p.isLocal;
  return (
    <li
      className={
        "flex flex-col gap-2 rounded-md border px-3 py-2 transition-colors " +
        (isSpeaking
          ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500 dark:bg-emerald-950/40"
          : "border-zinc-200 dark:border-zinc-800")
      }
    >
      <div className="flex items-center gap-2">
        <ParticipantName participant={p} />
        {isHost && (
          <span className="text-xs text-amber-500" title="Хост комнаты">
            👑
          </span>
        )}
        {p.isLocal && <span className="text-xs text-zinc-400">(вы)</span>}
        {forceMuted && (
          <span className="text-xs text-red-500" title="Заглушён хостом">
            🚫
          </span>
        )}
        {micMuted && (
          <span className="ml-auto text-xs text-zinc-400" title="Микрофон выключен">
            🔇
          </span>
        )}
      </div>

      {showHostControls && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => onModerate("transfer", p.identity)}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            👑 Сделать хостом
          </button>
          <button
            onClick={() => onModerate(forceMuted ? "unmute" : "mute", p.identity)}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {forceMuted ? "🔈 Вернуть микрофон" : "🚫 Заглушить"}
          </button>
          <button
            onClick={() => onModerate("kick", p.identity)}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-orange-600 hover:bg-orange-50 dark:border-zinc-700 dark:hover:bg-orange-950/30"
          >
            🚪 Кикнуть
          </button>
          <button
            onClick={() => onModerate("ban", p.identity)}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:hover:bg-red-950/30"
          >
            ⛔ Забанить
          </button>
        </div>
      )}

      {!p.isLocal && (
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleMute}
            title={muted ? "Включить звук участника" : "Заглушить участника для себя"}
            aria-label={muted ? "Включить звук участника" : "Заглушить участника для себя"}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:hover:bg-zinc-800 hover:bg-zinc-100"
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={Math.round(volume * 100)}
            onChange={(e) => onChangeVolume(Number(e.target.value) / 100)}
            disabled={muted}
            className="flex-1 accent-emerald-600 disabled:opacity-40"
            aria-label="Громкость участника"
          />
          <span className="w-10 text-right text-xs tabular-nums text-zinc-500">
            {Math.round(volume * 100)}%
          </span>
        </div>
      )}
    </li>
  );
}

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connected:
      return "на связи";
    case ConnectionState.Connecting:
      return "подключение…";
    case ConnectionState.Reconnecting:
      return "переподключение…";
    case ConnectionState.Disconnected:
      return "не подключено";
    default:
      return String(state);
  }
}

function CenteredCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </main>
  );
}
