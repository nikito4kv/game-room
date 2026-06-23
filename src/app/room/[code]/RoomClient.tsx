"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  ParticipantName,
  RoomAudioRenderer,
  useConnectionState,
  useIsSpeaking,
  useParticipants,
  useTracks,
  useTrackToggle,
  VideoTrack,
  type TrackReference,
} from "@livekit/components-react";
import { ConnectionState, MediaDeviceFailure, Participant, Track } from "livekit-client";
import {
  clearPassword,
  getHostKey,
  getNickname,
  setNickname as saveNickname,
  takePassword,
} from "@/lib/clientStorage";
import TacticsBoard from "./TacticsBoard";
import Banner from "@/components/Banner";

type JoinInfo = { token: string; serverUrl: string; title: string; isHost: boolean };

export default function RoomClient({ code }: { code: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState<string | null>(null);
  const [nickInput, setNickInput] = useState("");
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // «Заглушить всех» — управляет приёмом чужого аудио. Живёт здесь, потому что
  // <RoomAudioRenderer> рендерится на этом уровне, а кнопка — внутри RoomView.
  const [deafened, setDeafened] = useState(false);
  // Нет доступа к микрофону: не вылетаем, а пускаем слушателем (см. план).
  const [micDenied, setMicDenied] = useState(false);

  // Подтягиваем сохранённый ник. localStorage недоступен при SSR, поэтому
  // читаем его один раз после монтирования (эффект здесь оправдан).
  useEffect(() => {
    const saved = getNickname();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    if (saved) setNickname(saved);
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
      <RoomAudioRenderer muted={deafened} />
      <RoomView
        code={code}
        title={join.title}
        onLeave={() => router.push("/")}
        deafened={deafened}
        onToggleDeafen={() => setDeafened((v) => !v)}
        micDenied={micDenied}
        onMicDenied={() => setMicDenied(true)}
        onMicOk={() => setMicDenied(false)}
      />
    </LiveKitRoom>
  );
}

/** Внутренний вид комнаты — имеет доступ к контексту LiveKit. */
function RoomView({
  code,
  title,
  onLeave,
  deafened,
  onToggleDeafen,
  micDenied,
  onMicDenied,
  onMicOk,
}: {
  code: string;
  title: string;
  onLeave: () => void;
  deafened: boolean;
  onToggleDeafen: () => void;
  micDenied: boolean;
  onMicDenied: () => void;
  onMicOk: () => void;
}) {
  const participants = useParticipants();
  const state = useConnectionState();
  // Кнопка своего микрофона. onDeviceError ловит отказ при ручном включении.
  const mic = useTrackToggle({
    source: Track.Source.Microphone,
    onDeviceError: onMicDenied,
  });
  // Микрофон включился — баннер «нет доступа» больше не нужен.
  useEffect(() => {
    if (mic.enabled) onMicOk();
  }, [mic.enabled, onMicOk]);
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
        <button
          onClick={onLeave}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          Выйти
        </button>
      </header>

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

      <section className="flex flex-wrap gap-2">
        <button
          onClick={() => void mic.toggle()}
          disabled={mic.pending}
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
        <TacticsBoard code={code} active={stage === "board"} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-500">
          Участники ({participants.length})
        </h2>
        <ul className="flex flex-col gap-1">
          {participants.map((p) => (
            <ParticipantRow key={p.identity} p={p} />
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

/** Строка участника с индикацией говорящего и значком «в муте». */
function ParticipantRow({ p }: { p: Participant }) {
  const isSpeaking = useIsSpeaking(p);
  const micMuted = !p.isMicrophoneEnabled;
  return (
    <li
      className={
        "flex items-center rounded-md border px-3 py-2 transition-colors " +
        (isSpeaking
          ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500 dark:bg-emerald-950/40"
          : "border-zinc-200 dark:border-zinc-800")
      }
    >
      <ParticipantName participant={p} />
      {p.isLocal && <span className="ml-2 text-xs text-zinc-400">(вы)</span>}
      {micMuted && (
        <span className="ml-auto text-xs text-zinc-400" title="Микрофон выключен">
          🔇
        </span>
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
