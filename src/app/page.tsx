"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getNickname,
  setNickname as saveNickname,
  stashHostKey,
  stashPassword,
} from "@/lib/clientStorage";

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
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Game Room</h1>
        <p className="text-sm text-zinc-500">
          Голосовая игровая комната без регистрации. Заходи по коду.
        </p>
      </header>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Ник</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Как вас зовут в игре"
          maxLength={24}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      {error && (
        <p className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Создать комнату */}
        <form
          onSubmit={handleCreate}
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="font-semibold">Создать комнату</h2>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название комнаты"
            maxLength={40}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="password"
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Пароль (необязательно)"
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            Показать в публичном списке
          </label>
          <button
            type="submit"
            disabled={busy}
            className="mt-auto rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Создаём…" : "Создать"}
          </button>
        </form>

        {/* Войти по коду */}
        <form
          onSubmit={handleJoin}
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="font-semibold">Войти по коду</h2>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Код комнаты"
            maxLength={6}
            className="rounded-md border border-zinc-300 px-3 py-2 uppercase dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="password"
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
            placeholder="Пароль (если есть)"
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-auto rounded-md border border-emerald-600 px-4 py-2 font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
          >
            Войти
          </button>
        </form>
      </div>
    </main>
  );
}
