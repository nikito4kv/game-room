"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel, useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import Icon from "@/components/Icon";
import { playSfx } from "@/lib/audio/sfx";
import { useEphemeralFeed } from "./useEphemeralFeed";
import {
  CHAT_TOPIC,
  MAX_CHAT_LEN,
  MAX_CHAT_LOG,
  type ChatMessage,
  decodeChat,
  encodeChat,
  hueForIdentity,
  sanitizeChatText,
} from "@/lib/chat";

// Текстовый чат комнаты. Не мессенджер, а командный чат из игры: строки, а не
// пузыри; «позывной» (имя автора) своим цветом. Компонент ВСЕГДА смонтирован
// (видимость через prop `open`) — чтобы ловить сообщения и копить непрочитанные,
// пока панель закрыта. При закрытой панели входящее на пару секунд всплывает
// строкой внизу-слева и затухает (как team-chat), плюс растёт бейдж на кнопке.

// Анти-спам приёма: не больше N сообщений от одного участника за окно.
const SPAM_WINDOW_MS = 3000;
const SPAM_MAX = 8;

/** Время сообщения в формате ЧЧ:ММ. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function RoomChat({
  open,
  onClose,
  onUnread,
}: {
  open: boolean;
  onClose: () => void;
  onUnread: (n: number) => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  // Всплывающие строки при закрытой панели — общий хук эфемерной ленты (его же
  // использует Killfeed): enter→shown→leave, кап, очистка таймеров.
  const { items: toasts, push: pushToast } = useEphemeralFeed<ChatMessage>();

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  // Свежие значения для стабильного onMessage (иначе пере-подписка data-канала).
  const sendRef = useRef<((payload: Uint8Array, opts: { reliable?: boolean }) => Promise<void>) | null>(null);
  const openRef = useRef(open);
  const unreadRef = useRef(0);
  // Лог прилипает к низу, только если пользователь уже у дна (иначе он читает выше).
  const stickRef = useRef(true);
  // Времена входящих по identity — для простого анти-спама.
  const rateRef = useRef<Map<string, number[]>>(new Map());

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Участник вышел — выкидываем его запись из анти-спам-карты, чтобы она не росла
  // бесконечно за долгую сессию с потоком входов/выходов.
  useEffect(() => {
    const onLeft = (p: { identity: string }) => {
      rateRef.current.delete(p.identity);
    };
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  // Добавляет сообщение в лог с капом по длине.
  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      const next = prev.length >= MAX_CHAT_LOG ? prev.slice(prev.length - MAX_CHAT_LOG + 1) : prev;
      return [...next, m];
    });
  }, []);

  // Стабильный приём: текст из payload (санитизация), автор — из отправителя
  // пакета (анти-спуф), а не из payload.
  const onMessage = useCallback(
    (raw: { payload: Uint8Array; from?: { identity: string; name?: string } }) => {
      const wire = decodeChat(raw.payload);
      if (!wire) return;
      const text = sanitizeChatText(wire.text);
      if (!text) return;
      const identity = raw.from?.identity ?? "";
      if (!identity) return; // сообщения сервера/без отправителя игнорируем

      // Простой анти-спам: дропаем, если от одного участника слишком часто.
      const now = Date.now();
      const map = rateRef.current;
      const hits = (map.get(identity) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
      if (hits.length >= SPAM_MAX) {
        map.set(identity, hits);
        return;
      }
      hits.push(now);
      map.set(identity, hits);

      const msg: ChatMessage = {
        id: `${identity}-${seqRef.current++}`,
        identity,
        name: raw.from?.name || identity,
        text,
        ts: now,
        mine: false,
      };
      appendMessage(msg);
      if (!openRef.current) {
        pushToast(msg);
        playSfx("chat");
        unreadRef.current += 1;
        onUnread(unreadRef.current);
      }
    },
    [appendMessage, pushToast, onUnread],
  );

  const { send } = useDataChannel(CHAT_TOPIC, onMessage);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // Отправка: data-канал не зеркалит отправителю — поэтому своё сообщение кладём
  // в лог оптимистично, имя/identity берём у локального участника.
  const sendMessage = useCallback(() => {
    const text = sanitizeChatText(draft);
    if (!text) return;
    setDraft("");
    const identity = localParticipant.identity;
    appendMessage({
      id: `${identity}-${seqRef.current++}`,
      identity,
      name: localParticipant.name || identity,
      text,
      ts: Date.now(),
      mine: true,
    });
    // best-effort: до подключения publishData отклонится — молча игнорируем.
    void sendRef.current?.(encodeChat(text), { reliable: true }).catch(() => {});
  }, [draft, localParticipant, appendMessage]);

  // Открытие панели сбрасывает непрочитанные и ставит фокус в поле.
  useEffect(() => {
    if (!open) return;
    unreadRef.current = 0;
    onUnread(0);
    inputRef.current?.focus();
  }, [open, onUnread]);

  // Автоскролл к низу при новом сообщении, только если пользователь у дна.
  useEffect(() => {
    if (!open) return;
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Esc закрывает открытую панель (фокус вернёт RoomClient на кнопку дока).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const colorFor = (m: ChatMessage) =>
    m.mine ? "var(--accent-hi)" : `hsl(${hueForIdentity(m.identity)} 70% 70%)`;

  return (
    <>
      {/* Всплывающие строки при закрытой панели — внизу-слева, по диагонали от
          киллфида справа-сверху. Не перехватывают клики. */}
      {!open && toasts.length > 0 && (
        <div className="chat-toasts" aria-live="polite" aria-label="Новые сообщения">
          {toasts.map((t) => (
            <div
              key={t.key}
              className="chat-toast"
              data-state={t.state === "shown" ? undefined : t.state}
            >
              <b style={{ color: colorFor(t) }}>{t.name}</b>
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <section className="chat-panel" aria-label="Чат комнаты">
          <header className="chat-head">
            <span className="chat-title">Чат</span>
            <button
              type="button"
              className="chat-x"
              onClick={onClose}
              aria-label="Закрыть чат"
              title="Закрыть (Esc)"
            >
              <Icon name="close" size={16} />
            </button>
          </header>

          <div className="chat-log" ref={logRef} onScroll={onScroll} aria-live="polite">
            {messages.length === 0 ? (
              <p className="chat-empty">Пока тихо. Напишите первым</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={"chat-msg" + (m.mine ? " chat-msg--mine" : "")}>
                  <b className="chat-msg__who" style={{ color: colorFor(m) }}>
                    {m.mine ? "Вы" : m.name}
                  </b>
                  <span className="chat-msg__text">{m.text}</span>
                  <time className="chat-msg__time">{formatTime(m.ts)}</time>
                </div>
              ))
            )}
          </div>

          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <input
              ref={inputRef}
              className="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_CHAT_LEN}
              placeholder="Написать сообщение…"
              aria-label="Сообщение"
              autoComplete="off"
            />
            <button
              type="submit"
              className="chat-send"
              disabled={!draft.trim()}
              aria-label="Отправить"
              title="Отправить (Enter)"
            >
              <Icon name="send" size={18} />
            </button>
          </form>
        </section>
      )}
    </>
  );
}
