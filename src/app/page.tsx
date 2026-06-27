"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  getNickname,
  markEntry,
  setNickname as saveNickname,
  stashHostKey,
  stashPassword,
} from "@/lib/clientStorage";
import { EVENTS, track } from "@/lib/analytics/posthogClient";
import Banner from "@/components/Banner";
import Icon from "@/components/Icon";
import BorderGlow from "@/components/BorderGlow";
import GridScanBackground from "@/components/GridScanBackground";
import CodeInput from "@/components/CodeInput";

// Шаг окна лобби: выбор действия → конкретная форма. Одно окно вместо двух.
type Step = "choose" | "create" | "join";

export default function Home() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("choose");

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

  // Выбор действия на первом шаге: ник проверяем и запоминаем один раз здесь,
  // дальше форма показывает только поля комнаты.
  function chooseStep(next: "create" | "join") {
    setError(null);
    if (!rememberNick()) return;
    setStep(next);
  }

  function back() {
    setError(null);
    setStep("choose");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nick = nickname.trim();
    if (!nick) {
      setStep("choose");
      setError("Сначала введите ник");
      return;
    }
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
      markEntry(data.code, "created");
      track(EVENTS.roomCreated, {
        is_public: isPublic,
        has_password: !!createPassword.trim(),
      });
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
    const nick = nickname.trim();
    if (!nick) {
      setStep("choose");
      setError("Сначала введите ник");
      return;
    }
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setError("Введите код комнаты");
      return;
    }
    stashPassword(code, joinPassword.trim());
    markEntry(code, "code");
    router.push(`/room/${code}`);
  }

  // Движение шагов (motion). Острая ease-out как у --ease-out в CSS. При
  // prefers-reduced-motion гасим перемещения — оставляем только мягкий fade.
  const ease = [0.23, 1, 0.32, 1] as const;
  const stepVariants = {
    initial: { opacity: 0, y: reduce ? 0 : 10 },
    animate: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.28,
        ease,
        staggerChildren: reduce ? 0 : 0.06,
        delayChildren: 0.04,
      },
    },
    exit: { opacity: 0, y: reduce ? 0 : -8, transition: { duration: 0.16, ease } },
  };
  const itemVariants = {
    initial: { opacity: 0, y: reduce ? 0 : 8 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease } },
  };

  // Шапка шага 2: «Назад» + плашка с выбранным ником.
  const stepHeader = (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <button
        type="button"
        onClick={back}
        disabled={busy}
        className="btn btn--ghost btn--sm shrink-0"
      >
        <Icon name="arrow-left" size={16} />
        Назад
      </button>
      {/* min-w-0 + truncate: длинный ник (до 24 символов) не распирает шапку и
          не создаёт горизонтальный скролл внутри карточки — обрезается «…». */}
      <span className="chip min-w-0" title={nickname}>
        <Icon name="users" size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{nickname}</span>
      </span>
    </div>
  );

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-16">
      <GridScanBackground />

      {/* Логотип-вордмарк как заголовок страницы. */}
      <div className="rise flex justify-center" style={{ animationDelay: "40ms" }}>
        <Image
          src="/game-room-logo.png"
          alt="Game Room"
          width={800}
          height={263}
          priority
          className="h-auto w-full max-w-sm select-none"
        />
      </div>

      {/* Описание под логотипом, выровнено по центру. */}
      <p className="rise text-center text-sm text-text-dim" style={{ animationDelay: "80ms" }}>
        Голосовая игровая комната без регистрации. Заходи по коду — собирай отряд.
      </p>

      {error && <Banner tone="error">{error}</Banner>}

      {/* Карточка лобби. */}
      <div className="rise w-full" style={{ animationDelay: "120ms" }}>
        <BorderGlow
          className="w-full"
          borderRadius={14}
          glowColor="244 100 70"
          backgroundColor="var(--surface)"
          glowRadius={40}
          glowIntensity={1.0}
          coneSpread={25}
          colors={["#8e86ff", "#6e66ff", "#38d2f0"]}
        >
          <div className="flex flex-col gap-4 p-5">
            <AnimatePresence mode="wait" initial={false}>
              {step === "choose" && (
                <motion.div
                  key="choose"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex flex-col gap-4"
                >
                  <motion.label variants={itemVariants} className="field-label">
                    <span className="font-medium text-text">Ник</span>
                    <input
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder="Как вас зовут в игре"
                      maxLength={24}
                      className="field"
                    />
                  </motion.label>
                  <motion.div variants={itemVariants} className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => chooseStep("create")}
                      className="btn btn--primary btn--block"
                    >
                      <Icon name="plus" />
                      Создать комнату
                    </button>
                    <button
                      type="button"
                      onClick={() => chooseStep("join")}
                      className="btn btn--block"
                    >
                      <Icon name="login" />
                      Войти по коду
                    </button>
                  </motion.div>
                </motion.div>
              )}

              {step === "create" && (
                <motion.form
                  key="create"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  onSubmit={handleCreate}
                  className="flex flex-col gap-3"
                >
                  <motion.div variants={itemVariants}>{stepHeader}</motion.div>
                  <motion.h2 variants={itemVariants} className="panel-h">
                    Создать комнату
                  </motion.h2>
                  <motion.input
                    variants={itemVariants}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Название комнаты"
                    maxLength={40}
                    className="field"
                    autoFocus
                  />
                  <motion.input
                    variants={itemVariants}
                    type="password"
                    value={createPassword}
                    onChange={(e) => setCreatePassword(e.target.value)}
                    placeholder="Пароль (необязательно)"
                    className="field"
                  />
                  <motion.label
                    variants={itemVariants}
                    className="flex cursor-pointer items-center gap-2 text-sm text-text-dim"
                  >
                    <input
                      type="checkbox"
                      checked={isPublic}
                      onChange={(e) => setIsPublic(e.target.checked)}
                    />
                    Показать в публичном списке
                  </motion.label>
                  <motion.button
                    variants={itemVariants}
                    type="submit"
                    disabled={busy}
                    className="btn btn--primary btn--block mt-1"
                  >
                    <Icon name="plus" />
                    {busy ? "Создаём…" : "Создать"}
                  </motion.button>
                </motion.form>
              )}

              {step === "join" && (
                <motion.form
                  key="join"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  onSubmit={handleJoin}
                  className="flex flex-col gap-3"
                >
                  <motion.div variants={itemVariants}>{stepHeader}</motion.div>
                  <motion.h2 variants={itemVariants} className="panel-h">
                    Войти по коду
                  </motion.h2>
                  <motion.div variants={itemVariants}>
                    <CodeInput value={joinCode} onChange={setJoinCode} autoFocus />
                  </motion.div>
                  <motion.input
                    variants={itemVariants}
                    type="password"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                    placeholder="Пароль (если есть)"
                    className="field"
                  />
                  <motion.button
                    variants={itemVariants}
                    type="submit"
                    disabled={busy}
                    className="btn btn--block mt-1"
                  >
                    <Icon name="login" />
                    Войти
                  </motion.button>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </BorderGlow>
      </div>
    </main>
  );
}
