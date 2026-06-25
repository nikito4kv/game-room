"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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

// Статус комнаты: открытая (зелёный) / с паролем (жёлтый) / закрытая (красный,
// не кликабельна). variant задаёт цвет левого рейла строки, label — видимый
// текст (раньше смысл нёс только цвет иконки + tooltip — это было недоступно).
function statusOf(room: PublicRoomSummary): {
  icon: IconName;
  cls: string;
  label: string;
  variant: "open" | "pass" | "locked";
  clickable: boolean;
} {
  if (room.locked) {
    return { icon: "ban", cls: "text-danger", label: "Закрыта", variant: "locked", clickable: false };
  }
  if (room.hasPassword) {
    return { icon: "lock", cls: "text-warn", label: "Нужен пароль", variant: "pass", clickable: true };
  }
  return { icon: "lock-open", cls: "text-live", label: "Открыта", variant: "open", clickable: true };
}

export default function PublicRooms() {
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

  // Итог сверху: сколько всего живых комнат и людей в них (по всему списку,
  // до фильтра/поиска) — даёт ощущение «эфир идёт прямо сейчас».
  const stats = useMemo(
    () => ({
      count: rooms.length,
      people: rooms.reduce((sum, r) => sum + (r.numParticipants || 0), 0),
    }),
    [rooms],
  );

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
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <header className="rise flex flex-col gap-3">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Публичные <span className="text-accent-hi">комнаты</span>
        </h1>
        <p className="text-sm text-text-dim">
          Открытые голосовые комнаты — заходи к тем, кто уже в игре.
        </p>
        {!loading && stats.count > 0 && (
          <p className="flex items-center gap-2 text-sm text-text-dim">
            <span className="dot" />
            {stats.count} {plural(stats.count, ["комната", "комнаты", "комнат"])} ·{" "}
            {stats.people} {plural(stats.people, ["человек", "человека", "человек"])} в эфире
          </p>
        )}
      </header>

      <div className="rise flex flex-wrap items-center gap-3" style={{ animationDelay: "40ms" }}>
        <label className="relative flex flex-1 basis-64 items-center">
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
        <div className="seg" role="group" aria-label="Фильтр комнат по статусу">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="seg-btn"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
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
      ) : rooms.length === 0 ? (
        <div className="panel rise flex flex-col items-start gap-4 p-6">
          <p className="text-sm text-text-dim">
            Сейчас никто не в эфире. Создай комнату — остальные подтянутся.
          </p>
          <Link href="/" className="btn btn--primary">
            <Icon name="plus" />
            Создать комнату
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <p className="rise text-sm text-text-mute">
          Ничего не найдено — попробуй другой запрос или фильтр.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((room, i) => {
            const status = statusOf(room);
            const delay = { animationDelay: `${Math.min(i, 8) * 30}ms` };

            const main = (
              <div className="lobby-main">
                <h2 className="lobby-title">{room.title}</h2>
                <div className="lobby-sub">
                  {room.hostIdentity} · <span className="lobby-code">#{room.code}</span>
                </div>
              </div>
            );

            const meta = (
              <div className="lobby-meta">
                <span className={`lobby-status ${status.cls}`}>
                  <Icon name={status.icon} size={16} />
                  {status.label}
                </span>
                <span className="lobby-slots">
                  <span
                    className="slot-meter"
                    aria-label={`${room.numParticipants} из ${room.maxParticipants} мест занято`}
                  >
                    {Array.from({ length: room.maxParticipants }).map((_, s) => (
                      <span
                        key={s}
                        className={`slot ${s < room.numParticipants ? "slot--filled" : ""}`}
                      />
                    ))}
                  </span>
                  <span className="lobby-count">
                    {room.numParticipants}/{room.maxParticipants}
                  </span>
                </span>
                {status.clickable ? (
                  <span className="lobby-go" aria-hidden="true">
                    Зайти →
                  </span>
                ) : (
                  <span className="lobby-go lobby-go--dim" aria-hidden="true">
                    —
                  </span>
                )}
              </div>
            );

            return (
              <li key={room.code}>
                {status.clickable ? (
                  <Link
                    href={`/room/${room.code}`}
                    className={`lobby-row lobby-row--${status.variant} rise`}
                    style={delay}
                  >
                    {main}
                    {meta}
                  </Link>
                ) : (
                  <div className={`lobby-row lobby-row--${status.variant} rise`} style={delay}>
                    {main}
                    {meta}
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
