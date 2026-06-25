"use client";

import { useEffect } from "react";
import { useRoomContext } from "@livekit/components-react";
import { type Participant, RoomEvent } from "livekit-client";
import Icon, { type IconName } from "@/components/Icon";
import { playSfx } from "@/lib/audio/sfx";
import { useEphemeralFeed } from "./useEphemeralFeed";

// Лента событий («киллфид») — узнаваемый игровой HUD-элемент: вход/выход игроков
// всплывают вверху справа и сами затухают. Берём чистые, надёжные события
// комнаты (подключение/отключение), а не диффы метаданных — так лента честная и
// не шумит. Вход справа, выход — туда же (spatial consistency): глаз понимает,
// откуда элемент пришёл и куда уходит. Жизненный цикл (вход→затухание, кап,
// очистка таймеров) — в общем хуке useEphemeralFeed (его же использует чат).

type Evt = {
  icon: IconName;
  color: string;
  name: string;
  text: string;
};

export default function Killfeed() {
  const room = useRoomContext();
  const { items, push } = useEphemeralFeed<Evt>();

  useEffect(() => {
    const nameOf = (p: Participant) => p.name || p.identity;
    const onConnected = (p: Participant) => {
      playSfx("peer-join");
      push({ icon: "login", color: "var(--live)", name: nameOf(p), text: "вошёл в комнату" });
    };
    const onDisconnected = (p: Participant) => {
      playSfx("peer-leave");
      push({ icon: "logout", color: "var(--text-mute)", name: nameOf(p), text: "вышел" });
    };
    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
    };
  }, [room, push]);

  if (items.length === 0) return null;

  return (
    <div className="killfeed" aria-live="polite" aria-label="Лента событий">
      {items.map((e) => (
        <div
          key={e.key}
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
