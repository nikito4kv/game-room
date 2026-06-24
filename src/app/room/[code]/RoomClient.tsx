"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  ParticipantName,
  useConnectionState,
  useConnectionQualityIndicator,
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
  getNoiseSuppression,
  getOutputDevice,
  getNickname,
  getParticipantMutes,
  getParticipantVolumes,
  setInputGain,
  setMasterVolume,
  setNickname as saveNickname,
  setNoiseSuppression,
  setParticipantMute,
  setParticipantVolume,
  takePassword,
} from "@/lib/clientStorage";
import { MicProcessor } from "@/lib/audio/micProcessor";
import { initSfx, playSfx, setSfxDeafened } from "@/lib/audio/sfx";
import RoomAudio from "./RoomAudio";
import SettingsModal from "./SettingsModal";
import TacticsBoard from "./TacticsBoard";
import Killfeed from "./Killfeed";
import Banner from "@/components/Banner";
import Icon, { type IconName } from "@/components/Icon";
import { plural } from "@/lib/plural";

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

  // Парольная комната: на 401 показываем поле ввода пароля, а не тупик-ошибку.
  const [needPassword, setNeedPassword] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState(false);

  const requestToken = useCallback(
    async (nick: string, passwordOverride?: string) => {
      const password = passwordOverride ?? takePassword(code);
      const hostKey = getHostKey(code);
      try {
        const res = await fetch("/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, nickname: nick, password, hostKey }),
        });
        const data = await res.json();
        if (res.status === 401) {
          // Нужен пароль (или он неверный) — показываем ввод, а не тупик. «Неверный»
          // помечаем, только если пароль реально пробовали (введён вручную или
          // стащён из sessionStorage), а не при первом авто-входе без него.
          setPwError(passwordOverride != null || password != null);
          setNeedPassword(true);
          return;
        }
        if (!res.ok) {
          setNeedPassword(false);
          setError(data.error ?? "Не удалось войти в комнату");
          return;
        }
        // Пароль больше не нужен — стираем, чтобы не лежал в sessionStorage.
        clearPassword(code);
        setNeedPassword(false);
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

  async function handlePwSubmit(e: React.FormEvent) {
    e.preventDefault();
    const pw = pwInput.trim();
    if (!pw || pwBusy || !nickname) return;
    setPwBusy(true);
    setPwError(false);
    await requestToken(nickname, pw);
    setPwBusy(false);
  }

  // Нет ника (зашли по прямой ссылке) — спросим его.
  if (!nickname) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <form onSubmit={handleNickSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-text-dim">Введите ник, чтобы войти.</p>
          <input
            value={nickInput}
            onChange={(e) => setNickInput(e.target.value)}
            placeholder="Ник"
            maxLength={24}
            autoFocus
            className="field"
          />
          <button type="submit" className="btn btn--primary btn--block">
            <Icon name="login" />
            Войти
          </button>
        </form>
      </CenteredCard>
    );
  }

  if (needPassword) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <form onSubmit={handlePwSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-text-dim">Эта комната защищена паролем.</p>
          {pwError && <Banner tone="error">Неверный пароль. Попробуйте снова.</Banner>}
          <input
            type="password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            placeholder="Пароль"
            autoFocus
            className="field"
          />
          <button type="submit" disabled={pwBusy} className="btn btn--primary btn--block">
            <Icon name="login" />
            {pwBusy ? "Входим…" : "Войти"}
          </button>
          <button type="button" onClick={() => router.push("/")} className="btn btn--block">
            На главную
          </button>
        </form>
      </CenteredCard>
    );
  }

  if (error) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <Banner tone="error">{error}</Banner>
        <button onClick={() => router.push("/")} className="btn btn--block">
          На главную
        </button>
      </CenteredCard>
    );
  }

  if (!join) {
    return (
      <CenteredCard title={`Комната ${code}`}>
        <p className="flex items-center gap-2 text-sm text-text-dim">
          <span className="dot" /> Подключаемся…
        </p>
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
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        playSfx("kicked", { urgent: true });
        setRemoved(true);
      }
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

  // --- Звуки интерфейса (sfx) ---
  // Свои действия озвучиваются в местах вызова (см. toggleMic и т.п.), а
  // состояния (связь, модерация, права) — здесь, по переходам через ref.
  // Предзагрузка буферов и синхронизация настроек — один раз при входе.
  useEffect(() => {
    initSfx();
  }, []);
  // «Заглушить всё» гасит бытовые звуки (но не тревоги) — сообщаем модулю.
  useEffect(() => {
    setSfxDeafened(deafened);
  }, [deafened]);
  // Вошёл в комнату — один раз при первом успешном подключении.
  const enteredRef = useRef(false);
  useEffect(() => {
    if (state === ConnectionState.Connected && !enteredRef.current) {
      enteredRef.current = true;
      playSfx("enter");
    }
  }, [state]);
  // Потеря / восстановление связи (тревога — звучит даже при «заглушить всё»).
  const prevStateRef = useRef<ConnectionState | null>(null);
  useEffect(() => {
    const prev = prevStateRef.current;
    if (state === ConnectionState.Reconnecting && prev !== ConnectionState.Reconnecting) {
      playSfx("reconnecting", { urgent: true });
    } else if (state === ConnectionState.Connected && prev === ConnectionState.Reconnecting) {
      playSfx("reconnected", { urgent: true });
    }
    prevStateRef.current = state;
  }, [state]);
  // Хост заглушил мой микрофон.
  const prevForceMutedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevForceMutedRef.current === false && forceMutedMe) {
      playSfx("force-muted", { urgent: true });
    }
    prevForceMutedRef.current = forceMutedMe;
  }, [forceMutedMe]);
  // Нет доступа к микрофону.
  const prevMicDeniedRef = useRef(false);
  useEffect(() => {
    if (!prevMicDeniedRef.current && micDenied) playSfx("mic-denied", { urgent: true });
    prevMicDeniedRef.current = micDenied;
  }, [micDenied]);
  // Ошибка действия модерации.
  useEffect(() => {
    if (modError) playSfx("mod-error", { urgent: true });
  }, [modError]);
  // Мне передали права хоста. Только после grace-периода — иначе звук сыграл бы
  // на старте, пока метаданные/авто-передача устаканиваются (создатель — молча).
  const prevAmHostRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevAmHostRef.current === false && amHost && graceOver) playSfx("host-granted");
    prevAmHostRef.current = amHost;
  }, [amHost, graceOver]);
  // Комнату заперли / открыли (слышат все участники).
  const prevLockedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevLockedRef.current;
    if (prev !== null && prev !== locked && graceOver) playSfx(locked ? "lock" : "unlock");
    prevLockedRef.current = locked;
  }, [locked, graceOver]);

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

  // Обработка своего микрофона: усиление + шумоподавление (RNNoise). Процессор
  // создаём один раз (ленивый init), и gain, и шумодав меняем вживую без
  // переиздания трека.
  const [inputGain, setInputGainState] = useState(1);
  const [noiseSuppression, setNoiseSuppressionState] = useState(true);
  const [micProcessor] = useState(
    () =>
      // Колбэк отдаёт UI/localStorage фактическое состояние шумодава (например,
      // если RNNoise не загрузился) — чинит «залипание» тумблера и гонку кликов.
      new MicProcessor(getInputGain(), getNoiseSuppression(), (on) => {
        setNoiseSuppressionState(on);
        setNoiseSuppression(on);
      }),
  );
  // Какой именно микрофон-трек уже обработан — чтобы не вешать процессор дважды.
  const processedSidRef = useRef<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    setInputGainState(getInputGain());
    setNoiseSuppressionState(getNoiseSuppression());
  }, []);

  const changeInputGain = useCallback(
    (v: number) => {
      setInputGainState(v);
      setInputGain(v);
      micProcessor.setGain(v);
    },
    [micProcessor],
  );

  const changeNoiseSuppression = useCallback(
    (on: boolean) => {
      // Оптимистично переключаем UI; фактическое состояние (в т.ч. если RNNoise не
      // загрузился) вернёт колбэк onNoiseSuppressionChange ниже — он же чинит гонку
      // быстрых кликов (побеждает последняя завершившаяся операция, а не последняя
      // разрешившаяся вручную).
      setNoiseSuppressionState(on);
      setNoiseSuppression(on);
      void micProcessor.setNoiseSuppression(on);
    },
    [micProcessor],
  );

  // Навешиваем MicProcessor на локальный микрофон после публикации. Идемпотентно
  // через processedSidRef (повторная публикация / dev StrictMode не дублируют).
  useEffect(() => {
    if (!mic.enabled) return;
    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack as LocalAudioTrack | undefined;
    if (!track || !pub) return;
    if (processedSidRef.current === pub.trackSid) return;
    processedSidRef.current = pub.trackSid;
    // Усиление процессор уже знает (из конструктора + живых changeInputGain) —
    // повторно выставлять здесь не нужно, поэтому inputGain не в зависимостях.
    void track.setProcessor(micProcessor).catch(() => {
      // setProcessor @experimental — при сбое остаёмся на «чистом» микрофоне
      processedSidRef.current = null;
    });
  }, [mic.enabled, localParticipant, micProcessor]);
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
  const screensActive = screens.length > 0;
  // Что в центре: "room" (кружки), "screen" (демонстрация) или "board" (доска).
  // Оба контентных блока ВСЕГДА смонтированы (прячем через CSS) — доска продолжает
  // принимать чужие рисунки в фоне и не теряет накопленное (см. TacticsBoard).
  const [view, setView] = useState<"room" | "screen" | "board">("room");
  const toggleBoard = useCallback(() => {
    const opening = view !== "board";
    playSfx(opening ? "board-open" : "board-close");
    // Закрывая доску при активной демонстрации, возвращаемся к ЭКРАНУ, а не к
    // кружкам: иначе застряли бы на "room" — эффект ниже реагирует только на смену
    // screensActive и не перевычисляет вид при ручном выходе из доски.
    setView(opening ? "board" : screensActive ? "screen" : "room");
  }, [view, screensActive]);

  // Озвученные обёртки своих действий: звук играем в месте нажатия (а не по
  // смене состояния) — так не ловим ложных срабатываний на авто-публикацию
  // микрофона при входе и авто-раскрытие экрана.
  const toggleMic = useCallback(() => {
    if (mic.pending || forceMutedMe) return;
    playSfx(mic.enabled ? "mic-off" : "mic-on");
    void mic.toggle();
  }, [mic, forceMutedMe]);
  const toggleScreen = useCallback(() => {
    if (screen.pending) return;
    setScreenError(false);
    playSfx(screen.enabled ? "screen-stop" : "screen-start");
    void screen.toggle();
  }, [screen]);
  const toggleDeafenWithSound = useCallback(() => {
    // При ВЫКЛЮЧЕНИИ заглушки модульный флаг deafened ещё true (он синхронится
    // эффектом setSfxDeafened только после ре-рендера), поэтому без urgent звук
    // deafen-off отсёкся бы гейтом «не играть при deafen». Помечаем выключение
    // urgent — оно должно прозвучать.
    playSfx(deafened ? "deafen-off" : "deafen-on", deafened ? { urgent: true } : undefined);
    onToggleDeafen();
  }, [deafened, onToggleDeafen]);
  const leaveWithSound = useCallback(() => {
    playSfx("leave");
    onLeave();
  }, [onLeave]);
  // Демонстрация раскрывает центр сама: появилась шара (своя или чужая) — открываем
  // экран; пропала — возвращаемся к кружкам. Если открыта доска — её не трогаем.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- синхронизация вида с внешним состоянием демонстраций (LiveKit-треки)
    setView((v) => {
      if (screensActive && v === "room") return "screen";
      if (!screensActive && v === "screen") return "room";
      return v;
    });
  }, [screensActive]);
  // Открытое контекстное меню участника (одно на всю комнату), позиция — у курсора.
  const [menu, setMenu] = useState<{ p: Participant; x: number; y: number } | null>(null);
  // Запоминаем факт успешного подключения, чтобы отличить «потеряли связь» от
  // обычного начального состояния и от пересоздания компонента в dev (StrictMode).
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- латчим однократно факт подключения
    if (state === ConnectionState.Connected) setEverConnected(true);
  }, [state]);

  // Горячие клавиши — десктоп-аналог «button prompt». Привязки совпадают с
  // keycap-подсказками на кнопках (M/D/S/1/2). Берём e.code (физическая клавиша),
  // чтобы работало и на русской раскладке; не перехватываем при вводе в поля.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      switch (e.code) {
        case "KeyM":
          e.preventDefault();
          toggleMic();
          break;
        case "KeyD":
          e.preventDefault();
          toggleDeafenWithSound();
          break;
        case "KeyS":
          e.preventDefault();
          toggleScreen();
          break;
        case "Digit2":
          e.preventDefault();
          toggleBoard();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic, toggleDeafenWithSound, toggleScreen, toggleBoard]);

  // Хост удалил нас из комнаты — отдельный экран с понятной причиной.
  if (removed) {
    return (
      <CenteredCard title="Вас удалили из комнаты">
        <p className="text-sm text-text-dim">Хост удалил вас из этой комнаты.</p>
        <button onClick={onLeave} className="btn btn--primary btn--block">
          На главную
        </button>
      </CenteredCard>
    );
  }

  // Терминальный обрыв (после того как были на связи) — показываем экран, а не
  // молча выкидываем на главную. Кратковременные обрывы LiveKit чинит сам.
  if (everConnected && state === ConnectionState.Disconnected) {
    return (
      <CenteredCard title="Соединение потеряно">
        <p className="text-sm text-text-dim">Связь с комнатой прервалась.</p>
        <button onClick={onLeave} className="btn btn--primary btn--block">
          На главную
        </button>
      </CenteredCard>
    );
  }

  const playerCount = participants.length;

  return (
    <main
      className={
        "relative flex flex-1 flex-col items-center gap-6 px-4 pt-6 " +
        (view !== "room" ? "room-stage-open pb-40" : "pb-28")
      }
    >
      <Killfeed />

      <TopInfo title={title} code={code} playerCount={playerCount} locked={locked} />

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          masterVolume={masterVolume}
          onChangeMasterVolume={onChangeMasterVolume}
          inputGain={inputGain}
          onChangeInputGain={changeInputGain}
          noiseSuppression={noiseSuppression}
          onChangeNoiseSuppression={changeNoiseSuppression}
        />
      )}

      {(state === ConnectionState.Reconnecting ||
        micDenied ||
        screenError ||
        forceMutedMe ||
        modError) && (
        <div className="flex w-full max-w-md flex-col gap-2">
          {state === ConnectionState.Reconnecting && (
            <Banner tone="warn">Связь прервалась, переподключаемся…</Banner>
          )}
          {micDenied && (
            <Banner tone="warn">
              Нет доступа к микрофону — вас не слышно. Разрешите доступ в адресной
              строке браузера и нажмите «Микрофон».
            </Banner>
          )}
          {screenError && (
            <Banner tone="warn">
              Демонстрация не запустилась. Возможно, вы закрыли окно выбора —
              нажмите «Экран» ещё раз.
            </Banner>
          )}
          {forceMutedMe && (
            <Banner tone="warn">
              Хост заглушил ваш микрофон. Включить его снова сможет только хост.
            </Banner>
          )}
          {modError && <Banner tone="error">{modError}</Banner>}
        </div>
      )}

      {/* Центр: оверлей-сцена (экран/доска) + кружки участников. Оба контентных
          блока ВСЕГДА смонтированы; неактивный скрыт через hidden (доска не теряет
          накопленный рисунок и подписку на data-канал). */}
      <div className="flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-4">
        <div className={view === "screen" ? "stage-overlay" : "hidden"}>
          <ScreenShareStage screens={screens} />
        </div>
        <div className={view === "board" ? "stage-overlay" : "hidden"}>
          <TacticsBoard code={code} active={view === "board"} token={token} amHost={amHost} />
        </div>
        <div className="pc-stack">
          {participants.map((p) => (
            <ParticipantCircle
              key={p.identity}
              p={p}
              isHost={p.identity === hostIdentity}
              mutedByMe={!!mutes[p.identity]}
              onOpenMenu={(target, x, y) => setMenu({ p: target, x, y })}
            />
          ))}
        </div>
      </div>

      <Dock
        micEnabled={mic.enabled}
        micPending={mic.pending}
        forceMutedMe={forceMutedMe}
        onMic={toggleMic}
        deafened={deafened}
        onToggleDeafen={toggleDeafenWithSound}
        screenEnabled={screen.enabled}
        screenPending={screen.pending}
        onScreen={toggleScreen}
        boardOpen={view === "board"}
        onToggleBoard={toggleBoard}
        amHost={amHost}
        locked={locked}
        onLock={() => void doModerate(locked ? "unlock" : "lock")}
        hasHostKey={hasHostKey}
        onReturnHost={() => void doModerate("transfer", localParticipant.identity)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLeave={leaveWithSound}
      />

      {menu && (
        <ParticipantMenu
          key={menu.p.identity}
          p={menu.p}
          amHost={amHost}
          x={menu.x}
          y={menu.y}
          volume={volumes[menu.p.identity] ?? 1}
          muted={!!mutes[menu.p.identity]}
          onChangeVolume={(v) => onChangeParticipantVolume(menu.p.identity, v)}
          onToggleMute={() => onChangeParticipantMute(menu.p.identity, !mutes[menu.p.identity])}
          onModerate={doModerate}
          onClose={() => setMenu(null)}
        />
      )}
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
      <section className="stage relative flex aspect-video w-full items-center justify-center">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />
        <div className="flex flex-col items-center gap-3 text-text-mute">
          <Icon name="screen-share" size={40} className="opacity-50" />
          <span className="text-sm" style={{ textShadow: "var(--text-shadow-hud)" }}>
            Никто не показывает экран
          </span>
        </div>
      </section>
    );
  }

  const focused =
    screens.find((s) => s.publication.trackSid === focusedSid) ??
    screens[screens.length - 1];

  return (
    <section className="flex flex-col gap-3">
      <div className="stage relative">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />
        <span className="live-badge">
          <span className="dot" /> LIVE
        </span>
        <VideoTrack trackRef={focused} className="aspect-video w-full object-contain" />
        <span
          className="absolute bottom-2 left-2 z-[2] rounded-[var(--radius-sm)] bg-black/60 px-2 py-0.5 text-xs text-white"
          style={{ textShadow: "var(--text-shadow-hud)" }}
        >
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
                className="stage relative w-40 cursor-pointer overflow-hidden transition-shadow"
                style={
                  active
                    ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" }
                    : undefined
                }
              >
                <VideoTrack trackRef={s} className="aspect-video w-full object-contain" />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
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

/** Состояние кружка: говорит / заглушён / на связи (приоритет сверху вниз). */
type CircleState = "speaking" | "muted" | "idle";
function circleState(s: {
  isSpeaking: boolean;
  micOff: boolean;
  forceMuted: boolean;
  mutedByMe: boolean;
}): CircleState {
  if (s.isSpeaking) return "speaking";
  if (s.micOff || s.forceMuted || s.mutedByMe) return "muted";
  return "idle";
}

/**
 * Пинг до сервера. Сначала пробуем реальный RTT в мс из статистики WebRTC; путь
 * room.engine.* помечен @internal, поэтому строго через optional-chaining и
 * try/catch — при недоступности возвращаем null и откатываемся на индикатор качества.
 */
function useRttMs(): number | null {
  const room = useRoomContext();
  const [rtt, setRtt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const eng = (
          room as unknown as {
            engine?: {
              pcManager?: { publisher?: { getPC?: () => RTCPeerConnection; pc?: RTCPeerConnection } };
            };
          }
        ).engine;
        const pub = eng?.pcManager?.publisher;
        const pc = pub?.getPC?.() ?? pub?.pc;
        const stats = await pc?.getStats?.();
        if (!stats || !alive) return;
        let ms: number | null = null;
        stats.forEach((r: { type?: string; nominated?: boolean; currentRoundTripTime?: number }) => {
          if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number") {
            ms = Math.round(r.currentRoundTripTime * 1000);
          }
        });
        if (alive && ms !== null) setRtt(ms);
      } catch {
        // @internal-путь недоступен — тихо остаёмся на фоллбэке (индикатор качества)
      }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [room]);
  return rtt;
}

/** Пинг (мс) с откатом на индикатор качества связи, если RTT недоступен. */
function Ping() {
  const rtt = useRttMs();
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  if (rtt !== null) {
    const color = rtt < 80 ? "var(--live)" : rtt < 150 ? "var(--warn)" : "var(--danger)";
    return (
      <span className="chip" style={{ color }}>
        {rtt} мс
      </span>
    );
  }
  const map: Record<string, { t: string; c: string }> = {
    excellent: { t: "отлично", c: "var(--live)" },
    good: { t: "хорошо", c: "var(--live)" },
    poor: { t: "слабо", c: "var(--warn)" },
    lost: { t: "нет связи", c: "var(--danger)" },
    unknown: { t: "…", c: "var(--text-mute)" },
  };
  const q = map[quality] ?? map.unknown;
  return (
    <span className="chip" style={{ color: q.c }}>
      {q.t}
    </span>
  );
}

/**
 * Чип с кодом комнаты — он же кнопка «скопировать ссылку-приглашение».
 * Наведение подсвечивает код (см. .chip--copy в globals.css), клик копирует
 * https://<origin>/room/<КОД> и на ~1.5 c показывает зелёную галочку «Скопировано».
 * Ссылку строим лениво в обработчике (window только на клиенте). Тостов в проекте
 * нет — фидбэк держим локальным состоянием самой кнопки.
 */
function RoomCodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyLink() {
    const url = `${window.location.origin}/room/${code}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Небезопасный контекст или старый браузер — фоллбэк через временный textarea.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    if (!ok) return; // не вышло скопировать — не вводим в заблуждение фидбэком
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      className={`chip chip--copy${copied ? " is-copied" : ""}`}
      onClick={copyLink}
      aria-label={copied ? "Ссылка скопирована" : "Скопировать ссылку-приглашение"}
    >
      <Icon name={copied ? "check" : "hash"} size={15} />
      {copied ? "Скопировано" : <span className="chip--code">{code}</span>}
    </button>
  );
}

/** Верхняя инфо-строка по центру: название, код, пинг, число игроков. */
function TopInfo({
  title,
  code,
  playerCount,
  locked,
}: {
  title: string;
  code: string;
  playerCount: number;
  locked: boolean;
}) {
  return (
    <div className="rise flex flex-col items-center gap-2 text-center">
      <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <RoomCodeChip code={code} />
        <Ping />
        <span className="chip">
          <Icon name="users" size={15} />
          {playerCount} {plural(playerCount, ["игрок", "игрока", "игроков"])}
        </span>
        {locked && (
          <span className="chip" style={{ color: "var(--warn)" }}>
            <Icon name="lock" size={15} /> закрыта
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Кружок участника по центру комнаты: инициалы, кольцо-состояние (говорит/заглушён),
 * бейдж-иконка и корона хоста. Клик ЛКМ/ПКМ открывает контекстное меню (по себе —
 * не открываем: собой не управляют).
 */
function ParticipantCircle({
  p,
  isHost,
  mutedByMe,
  onOpenMenu,
}: {
  p: Participant;
  isHost: boolean;
  mutedByMe: boolean;
  onOpenMenu: (p: Participant, x: number, y: number) => void;
}) {
  const isSpeaking = useIsSpeaking(p);
  const micOff = !p.isMicrophoneEnabled;
  const info = useParticipantInfo({ participant: p });
  const forceMuted = useMemo(() => {
    if (!info.metadata) return false;
    try {
      return !!(JSON.parse(info.metadata) as { forceMuted?: boolean }).forceMuted;
    } catch {
      return false;
    }
  }, [info.metadata]);

  const cstate = circleState({ isSpeaking, micOff, forceMuted, mutedByMe });
  const badge: { icon: IconName; color: string } =
    cstate === "speaking"
      ? { icon: "volume", color: "var(--live)" }
      : cstate === "muted"
        ? { icon: "mic-off", color: "var(--danger)" }
        : { icon: "mic", color: "var(--text-mute)" };

  const open = (e: React.MouseEvent | React.KeyboardEvent, x: number, y: number) => {
    if (p.isLocal) return;
    e.preventDefault();
    onOpenMenu(p, x, y);
  };

  return (
    <div className="pc-wrap">
      <div
        className={
          "pc" +
          (cstate === "speaking" ? " pc--speaking" : cstate === "muted" ? " pc--muted" : "")
        }
        title={p.name || p.identity}
        role={p.isLocal ? undefined : "button"}
        tabIndex={p.isLocal ? undefined : 0}
        aria-label={p.isLocal ? undefined : `${p.name || p.identity} — действия`}
        onClick={(e) => open(e, e.clientX, e.clientY)}
        onContextMenu={(e) => open(e, e.clientX, e.clientY)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            const r = e.currentTarget.getBoundingClientRect();
            open(e, r.left + r.width / 2, r.bottom);
          }
        }}
      >
        {initials(p.name || p.identity)}
        {isHost && <Icon name="crown" size={16} className="pc-crown" />}
        <span
          className="pc-badge"
          style={{ "--pc-badge": badge.color } as React.CSSProperties}
          aria-hidden="true"
        >
          <Icon name={badge.icon} size={12} />
        </span>
      </div>
      <span className="pc-name">
        <ParticipantName participant={p} />
        {p.isLocal && " (вы)"}
      </span>
    </div>
  );
}

/**
 * Контекстное меню участника у курсора (ЛКМ/ПКМ по кружку). Объединяет локальные
 * настройки «для себя» (громкость, заглушить) и — для хоста — модерацию (передать
 * права, заглушить микрофон, кикнуть, забанить). Закрывается по клику вне и Esc.
 */
function ParticipantMenu({
  p,
  amHost,
  x,
  y,
  volume,
  muted,
  onChangeVolume,
  onToggleMute,
  onModerate,
  onClose,
}: {
  p: Participant;
  amHost: boolean;
  x: number;
  y: number;
  volume: number;
  muted: boolean;
  onChangeVolume: (v: number) => void;
  onToggleMute: () => void;
  onModerate: (action: ModerationAction, target?: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const info = useParticipantInfo({ participant: p });
  const forceMuted = useMemo(() => {
    if (!info.metadata) return false;
    try {
      return !!(JSON.parse(info.metadata) as { forceMuted?: boolean }).forceMuted;
    } catch {
      return false;
    }
  }, [info.metadata]);

  // После рендера прижимаем позицию к экрану, чтобы меню не вылезло за край.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (action: ModerationAction) => {
    onClose();
    onModerate(action, p.identity);
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="menu menu--at-cursor"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="menu-vol">
        <div className="menu-vol-head">
          <span>Громкость</span>
          <span style={{ color: "var(--text)" }}>{Math.round(volume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(volume * 100)}
          onChange={(e) => onChangeVolume(Number(e.target.value) / 100)}
          disabled={muted}
          aria-label="Громкость участника"
          style={{ width: "100%" }}
        />
      </div>
      <button role="menuitem" onClick={onToggleMute} className="menu-item">
        <Icon name={muted ? "volume-off" : "volume"} size={16} />
        {muted ? "Включить звук" : "Заглушить для себя"}
      </button>

      {amHost && (
        <>
          <div style={{ height: 1, background: "var(--border)", margin: "3px 4px" }} />
          <button role="menuitem" onClick={() => run("transfer")} className="menu-item">
            <Icon name="crown" size={16} /> Сделать хостом
          </button>
          <button
            role="menuitem"
            onClick={() => run(forceMuted ? "unmute" : "mute")}
            className="menu-item"
          >
            <Icon name={forceMuted ? "mic" : "mic-off"} size={16} />
            {forceMuted ? "Вернуть микрофон" : "Заглушить микрофон"}
          </button>
          <button role="menuitem" onClick={() => run("kick")} className="menu-item menu-item--danger">
            <Icon name="logout" size={16} /> Кикнуть
          </button>
          <button role="menuitem" onClick={() => run("ban")} className="menu-item menu-item--danger">
            <Icon name="ban" size={16} /> Забанить
          </button>
        </>
      )}
    </div>
  );
}

/** Нижний фиксированный док: всё управление комнатой, как панель абилок в игре. */
function Dock({
  micEnabled,
  micPending,
  forceMutedMe,
  onMic,
  deafened,
  onToggleDeafen,
  screenEnabled,
  screenPending,
  onScreen,
  boardOpen,
  onToggleBoard,
  amHost,
  locked,
  onLock,
  hasHostKey,
  onReturnHost,
  onOpenSettings,
  onLeave,
}: {
  micEnabled: boolean;
  micPending: boolean;
  forceMutedMe: boolean;
  onMic: () => void;
  deafened: boolean;
  onToggleDeafen: () => void;
  screenEnabled: boolean;
  screenPending: boolean;
  onScreen: () => void;
  boardOpen: boolean;
  onToggleBoard: () => void;
  amHost: boolean;
  locked: boolean;
  onLock: () => void;
  hasHostKey: boolean;
  onReturnHost: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="dock">
      <button
        onClick={onMic}
        disabled={micPending || forceMutedMe}
        title={forceMutedMe ? "Микрофон заглушён хостом" : "Микрофон (M)"}
        className={"dock-btn" + (micEnabled ? " dock-btn--live" : "")}
      >
        <Icon name={micEnabled ? "mic" : "mic-off"} size={18} />
        Микрофон
      </button>
      <button
        onClick={onToggleDeafen}
        title="Заглушить/включить весь звук (D)"
        className={"dock-btn" + (deafened ? " dock-btn--off" : "")}
      >
        <Icon name={deafened ? "volume-off" : "volume"} size={18} />
        {deafened ? "Звук выкл" : "Звук вкл"}
      </button>

      <span className="dock-sep" />

      <button
        onClick={onScreen}
        disabled={screenPending}
        title="Демонстрация экрана (S)"
        className={"dock-btn" + (screenEnabled ? " dock-btn--active" : "")}
      >
        <Icon name={screenEnabled ? "screen-stop" : "screen-share"} size={18} />
        {screenEnabled ? "Стоп показ" : "Экран"}
      </button>
      <button
        onClick={onToggleBoard}
        title="Доска тактик (2)"
        className={"dock-btn" + (boardOpen ? " dock-btn--active" : "")}
      >
        <Icon name="pencil" size={18} />
        Доска
      </button>

      <span className="dock-sep" />

      {amHost && (
        <button
          onClick={onLock}
          aria-label={locked ? "Открыть комнату" : "Закрыть комнату"}
          title={
            locked
              ? "Открыть комнату для новых участников"
              : "Закрыть комнату для новых участников"
          }
          className={"dock-btn dock-btn--icon" + (locked ? " dock-btn--active" : "")}
        >
          <Icon name={locked ? "lock-open" : "lock"} size={18} />
        </button>
      )}
      {!amHost && hasHostKey && (
        <button
          onClick={onReturnHost}
          aria-label="Вернуть права хоста"
          title="Вы создатель комнаты — вернуть себе права хоста"
          className="dock-btn dock-btn--icon"
          style={{ color: "var(--host)" }}
        >
          <Icon name="crown" size={18} />
        </button>
      )}
      <button
        onClick={onOpenSettings}
        aria-label="Настройки звука"
        title="Настройки звука"
        className="dock-btn dock-btn--icon"
      >
        <Icon name="sliders" size={18} />
      </button>
      <button
        onClick={onLeave}
        aria-label="Выйти из комнаты"
        title="Выйти из комнаты"
        className="dock-btn dock-btn--icon dock-btn--danger"
      >
        <Icon name="logout" size={18} />
      </button>
    </div>
  );
}

/** Инициалы для аватар-плитки: 1–2 буквы из ника. */
function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
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
      <div className="panel panel--accent rise flex flex-col gap-4 p-6">
        <h1 className="font-display text-xl font-bold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
