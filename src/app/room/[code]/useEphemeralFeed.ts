"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Общий жизненный цикл «эфемерной ленты» — всплывающих строк, которые сами
// затухают (killfeed входов/выходов, тосты чата). Логика одна: добавить элемент в
// состоянии "enter", на следующем кадре перевести в "shown" (чтобы сыграл CSS-
// переход появления), через holdMs пометить "leave", ещё через exitMs убрать.
// Видимых не больше max за раз; таймеры чистятся на анмаунте.
//
// Хук сам выдаёт числовой `key` для React-списка — поэтому НЕ конфликтует с
// собственными полями данных (например, строковым ChatMessage.id).

export type FeedState = "enter" | "shown" | "leave";
export type FeedEntry<T> = T & { key: number; state: FeedState };

export function useEphemeralFeed<T extends object>(
  opts: { holdMs?: number; exitMs?: number; max?: number } = {},
): { items: FeedEntry<T>[]; push: (data: T) => void } {
  const { holdMs = 4000, exitMs = 220, max = 4 } = opts;
  const [items, setItems] = useState<FeedEntry<T>[]>([]);
  const keyRef = useRef(0);
  // Отработавшие таймеры выкидываем из списка, иначе он рос бы бесконечно при
  // потоке элементов (cleanup эффекта чистит лишь оставшиеся, на анмаунте).
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const push = useCallback(
    (data: T) => {
      const key = keyRef.current++;
      setItems((prev) => [...prev.slice(-(max - 1)), { ...data, key, state: "enter" }]);
      // Следующий кадр — снимаем стартовое состояние, чтобы сыграл вход-переход.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setItems((prev) => prev.map((e) => (e.key === key ? { ...e, state: "shown" } : e))),
        ),
      );
      const drop = (t: ReturnType<typeof setTimeout>) => {
        const i = timersRef.current.indexOf(t);
        if (i !== -1) timersRef.current.splice(i, 1);
      };
      const hold = setTimeout(() => {
        drop(hold);
        setItems((prev) => prev.map((e) => (e.key === key ? { ...e, state: "leave" } : e)));
        const exit = setTimeout(() => {
          drop(exit);
          setItems((prev) => prev.filter((e) => e.key !== key));
        }, exitMs);
        timersRef.current.push(exit);
      }, holdMs);
      timersRef.current.push(hold);
    },
    [holdMs, exitMs, max],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  return { items, push };
}
