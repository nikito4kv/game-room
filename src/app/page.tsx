"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getNickname,
  setNickname as saveNickname,
  stashHostKey,
  stashPassword,
} from "@/lib/clientStorage";
import Banner from "@/components/Banner";
import Icon from "@/components/Icon";

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Поля «Создать»
  const [title, setTitle] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  // Поля «Войти»
  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");

  // Подставляем сохранённый ник. localStorage недоступен при SSR, поэтому
  // читаем его один раз после монтирования (эффект здесь оправдан).
  useEffect(() => {
    const saved = getNickname();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    if (saved) setNickname(saved);
  }, []);

  function rememberNick(): string | null {
    const nick = nickname.trim();
    if (!nick) {
      setError("Сначала введите ник");
      return null;
    }
    saveNickname(nick);
    return nick;
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nick = rememberNick();
    if (!nick) return;
    if (!title.trim()) {
      setError("Введите название комнаты");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: nick,
          title: title.trim(),
          password: createPassword.trim() || undefined,
          isPublic,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Не удалось создать комнату");
        return;
      }
      stashHostKey(data.code, data.hostKey);
      stashPassword(data.code, createPassword.trim());
      router.push(`/room/${data.code}`);
    } catch {
      setError("Сеть недоступна. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nick = rememberNick();
    if (!nick) return;
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setError("Введите код комнаты");
      return;
    }
    stashPassword(code, joinPassword.trim());
    router.push(`/room/${code}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="rise flex flex-col gap-3">
        <span className="chip self-start">
          <span className="dot" /> голосовое лобби
        </span>
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Game<span className="text-accent-hi"> Room</span>
        </h1>
        <p className="text-sm text-text-dim">
          Голосовая игровая комната без регистрации. Заходи по коду — собирай отряд.
        </p>
        <Link href="/rooms" className="btn btn--ghost btn--sm self-start">
          <Icon name="users" size={16} />
          Публичные комнаты
        </Link>
      </header>

      <label className="field-label rise" style={{ animationDelay: "40ms" }}>
        <span className="font-medium text-text">Ник</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Как вас зовут в игре"
          maxLength={24}
          className="field"
        />
      </label>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="grid gap-5 sm:grid-cols-2">
        {/* Создать комнату */}
        <form
          onSubmit={handleCreate}
          className="panel panel--accent rise flex flex-col gap-3 p-5"
          style={{ animationDelay: "80ms" }}
        >
          <h2 className="panel-h">Создать комнату</h2>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название комнаты"
            maxLength={40}
            className="field"
          />
          <input
            type="password"
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Пароль (необязательно)"
            className="field"
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dim">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            Показать в публичном списке
          </label>
          <button type="submit" disabled={busy} className="btn btn--primary btn--block mt-auto">
            <Icon name="plus" />
            {busy ? "Создаём…" : "Создать"}
          </button>
        </form>

        {/* Войти по коду */}
        <form
          onSubmit={handleJoin}
          className="panel rise flex flex-col gap-3 p-5"
          style={{ animationDelay: "120ms" }}
        >
          <h2 className="panel-h">Войти по коду</h2>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="КОД"
            maxLength={6}
            className="field font-mono uppercase tracking-[0.2em]"
          />
          <input
            type="password"
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
            placeholder="Пароль (если есть)"
            className="field"
          />
          <button type="submit" disabled={busy} className="btn btn--block mt-auto">
            <Icon name="login" />
            Войти
          </button>
        </form>
      </div>
    </main>
  );
}
