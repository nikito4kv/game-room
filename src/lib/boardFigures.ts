// Чистые хелперы фигурок (вынесены из компонента, чтобы покрыть юнит-тестами).
import type { Figure, Team } from "@/lib/board";

/**
 * Наименьший свободный номер для новой фигурки команды: 1..5, заполняя пропуски;
 * если 1..5 заняты — следующий по величине. Считаем только числовые подписи
 * этой же команды (ник вроде «Den» в нумерации не участвует).
 */
export function nextFigureNumber(figures: Figure[], team: Team): number {
  const used = new Set<number>();
  for (const f of figures) {
    if (f.team !== team) continue;
    const n = Number(f.label);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Стабильный id фигурки: identity автора + растущий счётчик. */
export function genFigureId(identity: string, seq: number): string {
  return `${identity}-fig-${seq}`;
}
