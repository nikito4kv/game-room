"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { type Participant, RoomEvent } from "livekit-client";
import Icon, { type IconName } from "@/components/Icon";

// Лента событий («киллфид») — узнаваемый игровой HUD-элемент: вход/выход игроков
// всплывают вверху справа и сами затухают. Берём чистые, надёжные события
// комнаты (подключение/отключение), а не диффы метаданных — так лента честная и
// не шумит. Вход справа, выход — туда же (spatial consistency): глаз понимает,
// откуда элемент пришёл и куда уходит. Авто-затухание, максимум 4 за раз.

type Evt = {
  id: number;
  icon: IconName;
  color: string;
  name: string;
  text: string;
  state: "enter" | "shown" | "leave";
};

const HOLD_MS = 4000; // сколько висит до затухания
const EXIT_MS = 220; // длительность ухода (синхронно с CSS-переходом .kf)
const MAX_VISIBLE = 4;

export default function Killfeed() {
  const room = useRoomContext();
  const [events, setEvents] = useState<Evt[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const push = useCallback((icon: IconName, color: string, name: string, text: string) => {
    const id = idRef.current++;
    setEvents((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, icon, color, name, text, state: "enter" }]);
    // Следующий кадр — снимаем стартовое состояние, чтобы сыграл вход-переход.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, state: "shown" } : e))),
      ),
    );
    timersRef.current.push(
      setTimeout(() => {
        setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, state: "leave" } : e)));
        timersRef.current.push(
          setTimeout(() => setEvents((prev) => prev.filter((e) => e.id !== id)), EXIT_MS),
        );
      }, HOLD_MS),
    );
  }, []);

  useEffect(() => {
    const nameOf = (p: Participant) => p.name || p.identity;
    const onConnected = (p: Participant) => push("login", "var(--live)", nameOf(p), "вошёл в комнату");
    const onDisconnected = (p: Participant) => push("logout", "var(--text-mute)", nameOf(p), "вышел");
    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    const timers = timersRef.current;
    return () => {
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      timers.forEach(clearTimeout);
    };
  }, [room, push]);

  if (events.length === 0) return null;

  return (
    <div className="killfeed" aria-live="polite" aria-label="Лента событий">
      {events.map((e) => (
        <div
          key={e.id}
          className="kf"
          data-state={e.state === "shown" ? undefined : e.state}
          style={{ "--evt": e.color } as React.CSSProperties}
        >
          <Icon name={e.icon} size={18} className="kf-ic" />
          <span>
            <b>{e.name}</b> {e.text}
          </span>
        </div>
      ))}
    </div>
  );
}
