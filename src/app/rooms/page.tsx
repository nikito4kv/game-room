"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Banner from "@/components/Banner";
import Icon, { type IconName } from "@/components/Icon";
import { plural } from "@/lib/plural";
import type { PublicRoomSummary } from "@/lib/publicRooms";

type StatusFilter = "all" | "open" | "password" | "locked";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "open", label: "Открытые" },
  { value: "password", label: "С паролем" },
  { value: "locked", label: "Закрытые" },
];

// Статус-иконка комнаты: открытая (зелёный замок) / с паролем (жёлтый) /
// закрытая (перечёркнутый круг, не кликабельна).
function statusOf(room: PublicRoomSummary): {
  icon: IconName;
  cls: string;
  label: string;
  clickable: boolean;
} {
  if (room.locked) {
    return { icon: "ban", cls: "text-danger", label: "Закрыта", clickable: false };
  }
  if (room.hasPassword) {
    return { icon: "lock", cls: "text-warn", label: "Пароль", clickable: true };
  }
  return { icon: "lock-open", cls: "text-live", label: "Открыта", clickable: true };
}

export default function PublicRooms() {
  const router = useRouter();
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  // Кулдаун обновления: ответ из 5-сек серверного кэша приходит мгновенно, без
  // паузы кнопка/возврат на вкладку легко выбили бы лимит 30/мин (429). Ref —
  // чтобы guard в мемоизированном load читал актуальное значение, не из замыкания.
  const [cooldown, setCooldown] = useState(false);
  const cooldownRef = useRef(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (force = false) => {
    if (!force && cooldownRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Не удалось загрузить список комнат");
        return;
      }
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch {
      setError("Сеть недоступна. Попробуйте ещё раз.");
    } finally {
      setLoading(false);
      cooldownRef.current = true;
      setCooldown(true);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = setTimeout(() => {
        cooldownRef.current = false;
        setCooldown(false);
      }, 3000);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовая загрузка списка при монтировании
    void load(true);
    return () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    };
  }, [load]);

  // Ревалидация при возврате на вкладку — список «живой» без поллинга; guard
  // кулдауна не даёт частить при флаппинге фокуса.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter((r) => {
      if (filter === "open" && (r.locked || r.hasPassword)) return false;
      if (filter === "password" && (r.locked || !r.hasPassword)) return false;
      if (filter === "locked" && !r.locked) return false;
      if (q && !(r.title ?? "").toLowerCase().includes(q) && !(r.code ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rooms, query, filter]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="rise flex flex-col gap-3">
        <Link href="/" className="btn btn--ghost btn--sm self-start">
          <Icon name="login" size={14} className="rotate-180" /> На главную
        </Link>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Публичные <span className="text-accent-hi">комнаты</span>
        </h1>
        <p className="text-sm text-text-dim">
          Открытые голосовые комнаты — заходи к тем, кто уже в игре.
        </p>
      </header>

      <div className="rise flex flex-wrap items-center gap-3" style={{ animationDelay: "40ms" }}>
        <label className="relative flex flex-1 items-center">
          <span className="pointer-events-none absolute left-3 text-text-mute">
            <Icon name="search" size={16} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию или коду"
            className="field w-full"
            style={{ paddingLeft: "2.25rem" }}
          />
        </label>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
          className="field"
          aria-label="Фильтр комнат"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || cooldown}
          className="btn btn--icon"
          aria-label="Обновить список"
          title="Обновить"
        >
          <Icon name="refresh" />
        </button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {loading ? (
        <p className="text-sm text-text-mute">Загрузка…</p>
      ) : visible.length === 0 ? (
        <p className="rise text-sm text-text-mute">
          {rooms.length === 0
            ? "Сейчас нет открытых комнат. Создай свою на главной."
            : "Ничего не найдено — попробуй другой запрос или фильтр."}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {visible.map((room, i) => {
            const status = statusOf(room);
            const players = `${room.numParticipants}/${room.maxParticipants}`;
            const inner = (
              <>
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-display text-base font-bold leading-tight">
                    {room.title}
                  </h2>
                  <span
                    className={`flex shrink-0 items-center gap-1 text-xs ${status.cls}`}
                    title={status.label}
                  >
                    <Icon name={status.icon} size={16} />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip chip--code">
                    <Icon name="hash" size={13} />
                    {room.code}
                  </span>
                  <span className="chip">
                    <Icon name="users" size={14} />
                    {room.numParticipants} {plural(room.numParticipants, [
                      "участник",
                      "участника",
                      "участников",
                    ])}
                  </span>
                </div>
                <span className="mt-auto text-xs text-text-mute">
                  {status.clickable ? `Хост: ${room.hostIdentity} · ${players}` : "Закрыта для входа"}
                </span>
              </>
            );

            const baseClass = "panel flex flex-col gap-3 p-4 text-left rise";

            return (
              <li key={room.code}>
                {status.clickable ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/room/${room.code}`)}
                    className={`${baseClass} w-full transition-colors hover:border-border-strong`}
                    style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                  >
                    {inner}
                  </button>
                ) : (
                  <div
                    className={`${baseClass} cursor-not-allowed opacity-60`}
                    style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                  >
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
