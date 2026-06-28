# Тактическая доска CS2: карты, фигурки, стрелки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить доску тактик в рабочий инструмент для CS2: встроенная библиотека карт, перетаскиваемые фигурки-игроки (CT/T) с синхроном, прямые стрелки (сплошная = раш, пунктир = ротация) и боковой HUD-тулбар вместо перегруженного.

**Architecture:** Всё кладётся поверх существующего протокола доски ([board.ts](../../../src/lib/board.ts)) и его data-канала LiveKit (топик `board`): новые сообщения несут тот же `epoch`, валидируются так же строго, доезжают в снапшоте поздно зашедшим. Рендер — 4 слоя: фон-`<img>`, `<canvas>` (кисть/ластик, как сейчас), `<svg>` (стрелки), DOM (фигурки). [TacticsBoard.tsx](../../../src/app/room/[code]/TacticsBoard.tsx) остаётся оркестратором; слои и рельс выносятся в отдельные компоненты.

**Tech Stack:** Next.js 16 (нестандартный — см. `AGENTS.md`), React 19, TypeScript, Tailwind v4, LiveKit (`@livekit/components-react`), Vitest (node-окружение).

**Spec:** [2026-06-28-cs2-tactics-board-design.md](../specs/2026-06-28-cs2-tactics-board-design.md)

## Global Constraints

Эти требования действуют в КАЖДОЙ задаче (повторно не дублируются):

- **Next.js нестандартный.** Перед правкой framework-файлов сверяться с `node_modules/next/dist/docs/`. В этом плане framework-файлы не трогаются, но правило в силе.
- **Комментарии и UI-текст — на русском** (стиль кодовой базы).
- **Все входящие из data-канала данные не доверенные** (у всех участников есть `canPublishData`): любую форму валидируем санитайзером перед применением; на приёме — жёсткие потолки.
- **Координаты — нормированные 0..1** относительно рамки доски (как у штрихов).
- **Тесты:** Vitest, файлы `src/**/*.test.ts`, запуск `npm test` (= `vitest run`). Стиль — русскоязычные `describe`/`it`, импорт через алиас `@/...`.
- **Доступность (DESIGN_SYSTEM §10):** интерактивные цели ≥44px, текст ≥14px, видимый фокус, `aria-pressed` на тумблерах инструментов, `prefers-reduced-motion`, цвет всегда продублирован иконкой/подписью.
- **Коммиты частые**, по одному на задачу, в стиле репозитория: `feat(board): …`, `fix(board): …`, `test(board): …`.
- **Команды:** CT — синий `#3aa0ff` (граница `#bfe0ff`, текст `#04101f`), T — золотой `#f5b70a` (граница `#ffe39a`, текст `#1a1205`).

---

## File Structure

| Файл | Действие | Ответственность |
|---|---|---|
| `src/lib/board.ts` | Modify | Протокол: типы `Figure`/`Arrow`, сообщения, санитайзеры, лимиты, вайтлист карт. |
| `src/lib/board.test.ts` | Modify | Тесты новых санитайзеров и границ лимитов. |
| `src/lib/maps.ts` | Create | Манифест карт CS2. |
| `src/lib/maps.test.ts` | Create | Валидность манифеста (src проходит вайтлист, id уникальны). |
| `src/lib/boardFigures.ts` | Create | Чистые хелперы фигурок (`nextFigureNumber`, `genFigureId`). |
| `src/lib/boardFigures.test.ts` | Create | Тесты хелперов. |
| `public/maps/cs2/*.jpg` | Create | Радар-миникарты (9 карт). |
| `src/components/Icon.tsx` | Modify | Иконки `move` и `arrow`. |
| `src/app/room/[code]/BoardRail.tsx` | Create | Боковой рельс инструментов + контекстный поповер (презентационный). |
| `src/app/room/[code]/MapPicker.tsx` | Create | Чип-дропдаун выбора карты (хосту). |
| `src/app/room/[code]/FigureLayer.tsx` | Create | DOM-слой фигурок: рендер + драг + выделение + правка подписи. |
| `src/app/room/[code]/ArrowLayer.tsx` | Create | SVG-слой стрелок: рендер + рисование резиновой линии + выделение. |
| `src/app/room/[code]/TacticsBoard.tsx` | Modify | Оркестрация слоёв, состояние инструмента, приём/отправка новых сообщений, снапшот. |

**Уточнение к спеке:** отдельный хук `useBoardChannel` из спеки НЕ выделяем. Сетевая логика (`onMessage`, `sendSnapshot`, `broadcast`) тесно связана с ref-ами доски; перенос её в хук — крупный хрупкий рефактор без выигрыша. `TacticsBoard` остаётся оркестратором (как и задумано спекой), а изоляция достигается выносом презентационных слоёв (`FigureLayer`, `ArrowLayer`, `BoardRail`, `MapPicker`). Это сознательное упрощение, остальная архитектура спеки сохранена.

**Порядок фаз:** 1) Протокол → 2) Карты → 3) Рельс+инструменты → 4) Фигурки → 5) Стрелки → 6) «Очистить всё».

---

## Фаза 1 — Протокол (board.ts)

### Task 1: Тип `Figure` и санитайзеры

**Files:**
- Modify: `src/lib/board.ts`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: существующие `clamp01`, `safeColor`, `MAX_ID_LEN`, приватный `isFiniteNum`.
- Produces: `type Team = "ct" | "t"`; `type Figure = { id: string; team: Team; label: string; x: number; y: number }`; `MAX_FIGURES = 50`; `MAX_LABEL_LEN = 16`; `safeLabel(v: unknown): string`; `sanitizeFigure(raw: unknown): Figure | null`; `sanitizeFigures(raw: unknown): Figure[]`.

- [ ] **Step 1: Написать падающий тест**

В `src/lib/board.test.ts` добавить импорты `Figure, MAX_FIGURES, MAX_LABEL_LEN, safeLabel, sanitizeFigure, sanitizeFigures` к существующему блоку импорта из `@/lib/board`, затем в конец файла:

```ts
describe("safeLabel", () => {
  it("обрезает по длине и чистит управляющие символы", () => {
    expect(safeLabel("  Player  ")).toBe("Player");
    expect(safeLabel("a\n\tb")).toBe("ab");
    expect(safeLabel("x".repeat(40))).toHaveLength(MAX_LABEL_LEN);
    expect(safeLabel(123)).toBe("");
    expect(safeLabel(null)).toBe("");
  });
});

describe("sanitizeFigure", () => {
  it("принимает корректную фигурку и зажимает координаты", () => {
    expect(sanitizeFigure({ id: "p1", team: "ct", label: "1", x: 1.5, y: -0.2 })).toEqual({
      id: "p1", team: "ct", label: "1", x: 1, y: 0,
    });
  });
  it("отвергает кривую команду, id и нечисловые координаты", () => {
    expect(sanitizeFigure({ id: "p1", team: "x", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "", team: "ct", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "a".repeat(200), team: "ct", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "p1", team: "ct", label: "", x: "0.5", y: 0.5 })).toBeNull();
    expect(sanitizeFigure(null)).toBeNull();
  });
});

describe("sanitizeFigures", () => {
  it("фильтрует мусор и режет по MAX_FIGURES", () => {
    const ok = { id: "p", team: "t", label: "", x: 0.1, y: 0.1 };
    expect(sanitizeFigures([ok, "junk", { id: "q", team: "z", x: 0, y: 0 }])).toHaveLength(1);
    const many = Array.from({ length: MAX_FIGURES + 10 }, (_, i) => ({ ...ok, id: `p${i}` }));
    expect(sanitizeFigures(many)).toHaveLength(MAX_FIGURES);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- board`
Expected: FAIL — `safeLabel`/`sanitizeFigure`/`sanitizeFigures` не экспортированы.

- [ ] **Step 3: Реализовать в `board.ts`**

После блока с `MAX_ID_LEN` (строка ~58) добавить лимиты:

```ts
/** Максимум фигурок-игроков на доске. */
export const MAX_FIGURES = 50;
/** Максимальная длина подписи фигурки. */
export const MAX_LABEL_LEN = 16;
```

После определения `Stroke` (строка ~19) добавить типы:

```ts
/** Команда фигурки: CT или T. */
export type Team = "ct" | "t";

/** Фигурка-игрок на доске. Координаты — нормированные 0..1. */
export type Figure = { id: string; team: Team; label: string; x: number; y: number };
```

Рядом с `safeColor` (строка ~109) добавить санитайзеры:

```ts
function isTeam(v: unknown): v is Team {
  return v === "ct" || v === "t";
}

/** Чистая подпись: убираем управляющие символы/переводы строк, trim, обрезаем по длине. */
export function safeLabel(v: unknown): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex -- намеренно вырезаем управляющие символы из недоверенного ввода
  return v.replace(/[ -]/g, "").trim().slice(0, MAX_LABEL_LEN);
}

/** Приводит произвольный объект к корректной Figure или возвращает null. */
export function sanitizeFigure(raw: unknown): Figure | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !f.id || f.id.length > MAX_ID_LEN) return null;
  if (!isTeam(f.team)) return null;
  if (!isFiniteNum(f.x) || !isFiniteNum(f.y)) return null;
  return { id: f.id, team: f.team, label: safeLabel(f.label), x: clamp01(f.x), y: clamp01(f.y) };
}

/** Приводит входной массив фигурок к корректным Figure[] (с кэпом MAX_FIGURES). */
export function sanitizeFigures(raw: unknown): Figure[] {
  if (!Array.isArray(raw)) return [];
  const out: Figure[] = [];
  for (const r of raw) {
    const f = sanitizeFigure(r);
    if (f) out.push(f);
    if (out.length >= MAX_FIGURES) break;
  }
  return out;
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- board`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "feat(board): тип Figure и санитайзеры фигурок"
```

---

### Task 2: Тип `Arrow` и санитайзеры

**Files:**
- Modify: `src/lib/board.ts`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: `clamp01`, `safeColor`, `MAX_ID_LEN`, `isFiniteNum`.
- Produces: `type ArrowStyle = "solid" | "dashed"`; `type Arrow = { id: string; color: string; style: ArrowStyle; x1: number; y1: number; x2: number; y2: number }`; `MAX_ARROWS = 100`; `sanitizeArrow(raw: unknown): Arrow | null`; `sanitizeArrows(raw: unknown): Arrow[]`.

- [ ] **Step 1: Написать падающий тест**

Добавить к импортам `Arrow, ArrowStyle, MAX_ARROWS, sanitizeArrow, sanitizeArrows`, затем:

```ts
describe("sanitizeArrow", () => {
  const base = { id: "a1", color: "#ef4444", style: "solid", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8 };
  it("принимает корректную стрелку", () => {
    expect(sanitizeArrow(base)).toEqual(base);
  });
  it("зажимает координаты и чинит цвет на дефолт", () => {
    expect(sanitizeArrow({ ...base, color: "red", x1: 2, y2: -1 })).toEqual({
      ...base, color: "#ef4444", x1: 1, y2: 0,
    });
  });
  it("отвергает кривой стиль, id и нечисловые координаты", () => {
    expect(sanitizeArrow({ ...base, style: "wavy" })).toBeNull();
    expect(sanitizeArrow({ ...base, id: "" })).toBeNull();
    expect(sanitizeArrow({ ...base, x1: "0.1" })).toBeNull();
    expect(sanitizeArrow(42)).toBeNull();
  });
});

describe("sanitizeArrows", () => {
  it("фильтрует мусор и режет по MAX_ARROWS", () => {
    const ok = { id: "a", color: "#fff", style: "dashed", x1: 0, y1: 0, x2: 1, y2: 1 };
    expect(sanitizeArrows([ok, "x", { id: "b", style: "no" }])).toHaveLength(1);
    const many = Array.from({ length: MAX_ARROWS + 5 }, (_, i) => ({ ...ok, id: `a${i}` }));
    expect(sanitizeArrows(many)).toHaveLength(MAX_ARROWS);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- board`
Expected: FAIL — `sanitizeArrow`/`sanitizeArrows` не экспортированы.

- [ ] **Step 3: Реализовать в `board.ts`**

Рядом с лимитами добавить:

```ts
/** Максимум стрелок на доске. */
export const MAX_ARROWS = 100;
```

Рядом с типом `Figure` добавить:

```ts
/** Стиль стрелки: сплошная (раш) или пунктир (ротация). */
export type ArrowStyle = "solid" | "dashed";

/** Прямая стрелка между двумя точками. Координаты — нормированные 0..1. */
export type Arrow = { id: string; color: string; style: ArrowStyle; x1: number; y1: number; x2: number; y2: number };
```

Рядом с `sanitizeFigure` добавить:

```ts
function isArrowStyle(v: unknown): v is ArrowStyle {
  return v === "solid" || v === "dashed";
}

/** Приводит произвольный объект к корректной Arrow или возвращает null. */
export function sanitizeArrow(raw: unknown): Arrow | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id || a.id.length > MAX_ID_LEN) return null;
  if (!isArrowStyle(a.style)) return null;
  const { x1, y1, x2, y2 } = a;
  if (!isFiniteNum(x1) || !isFiniteNum(y1) || !isFiniteNum(x2) || !isFiniteNum(y2)) return null;
  return {
    id: a.id,
    color: safeColor(a.color, "#ef4444"),
    style: a.style,
    x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2),
  };
}

/** Приводит входной массив стрелок к корректным Arrow[] (с кэпом MAX_ARROWS). */
export function sanitizeArrows(raw: unknown): Arrow[] {
  if (!Array.isArray(raw)) return [];
  const out: Arrow[] = [];
  for (const r of raw) {
    const a = sanitizeArrow(r);
    if (a) out.push(a);
    if (out.length >= MAX_ARROWS) break;
  }
  return out;
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- board`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "feat(board): тип Arrow и санитайзеры стрелок"
```

---

### Task 3: Вайтлист встроенных карт в `sanitizeBgUrl`

**Files:**
- Modify: `src/lib/board.ts:175-180`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Produces: `BUILTIN_MAP_RE` (экспорт), расширенный `sanitizeBgUrl`, который дополнительно пропускает пути вида `/maps/cs2/<id>.<ext>`.

- [ ] **Step 1: Написать падающий тест**

Добавить к импортам `BUILTIN_MAP_RE`, затем:

```ts
describe("sanitizeBgUrl — встроенные карты", () => {
  it("пропускает корне-относительные пути карт", () => {
    expect(sanitizeBgUrl("/maps/cs2/mirage.jpg")).toBe("/maps/cs2/mirage.jpg");
    expect(sanitizeBgUrl("/maps/cs2/de_nuke.webp")).toBe("/maps/cs2/de_nuke.webp");
  });
  it("по-прежнему пропускает http(s) и data:image", () => {
    expect(sanitizeBgUrl("https://x/y.png")).toBe("https://x/y.png");
    expect(sanitizeBgUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  it("блокирует обход каталога и чужие пути", () => {
    expect(sanitizeBgUrl("/maps/cs2/../../etc/passwd")).toBeNull();
    expect(sanitizeBgUrl("/etc/passwd")).toBeNull();
    expect(sanitizeBgUrl("/maps/cs2/mirage.svg")).toBeNull();
    expect(sanitizeBgUrl("javascript:alert(1)")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- board`
Expected: FAIL — путь карты возвращает `null`; `BUILTIN_MAP_RE` не экспортирован.

- [ ] **Step 3: Реализовать**

Заменить тело `sanitizeBgUrl` (строки ~175-180):

```ts
/**
 * Белый список встроенных карт: строго `/maps/cs2/<id>.<ext>` без обхода каталога.
 * Якоря ^$ и отсутствие точки/слэша внутри id не дают подсунуть `..` или чужой путь.
 */
export const BUILTIN_MAP_RE = /^\/maps\/cs2\/[a-z0-9_-]+\.(jpg|png|webp)$/i;

/**
 * Разрешаем как фон: http(s), data:image и встроенные карты (см. BUILTIN_MAP_RE).
 * Иначе по data-каналу нельзя подсунуть произвольную строку (CSS/JS-инъекции).
 */
export function sanitizeBgUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url) || BUILTIN_MAP_RE.test(url)) return url;
  return null;
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- board`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "feat(board): пускать встроенные карты /maps/cs2 как фон"
```

---

### Task 4: Новые сообщения в `BoardMessage` и расширение снапшота

**Files:**
- Modify: `src/lib/board.ts:30-42`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: `Figure`, `Arrow` (Task 1, 2).
- Produces: расширенный union `BoardMessage` с вариантами `fig-add`/`fig-move`/`fig-del`/`arrow-add`/`arrow-del` и полями `figures?`/`arrows?` в `sync-state`. Семантика `fig-add` — **upsert по id** (создать или обновить team/label/позицию).

- [ ] **Step 1: Написать падающий тест**

```ts
describe("кодирование новых сообщений доски", () => {
  it("fig-add сериализуется и разбирается без потерь", () => {
    const msg = { t: "fig-add", epoch: 3, fig: { id: "p1", team: "ct", label: "1", x: 0.5, y: 0.5 } } as const;
    expect(decodeBoardMessage(encodeBoardMessage(msg))).toEqual(msg);
  });
  it("arrow-add сериализуется и разбирается без потерь", () => {
    const msg = { t: "arrow-add", epoch: 1, arrow: { id: "a1", color: "#fff", style: "dashed", x1: 0, y1: 0, x2: 1, y2: 1 } } as const;
    expect(decodeBoardMessage(encodeBoardMessage(msg))).toEqual(msg);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- board`
Expected: FAIL — TypeScript-ошибка: литералы не подходят под текущий `BoardMessage`.

- [ ] **Step 3: Реализовать**

В union `BoardMessage` (строки ~30-42) добавить перед `sync-state` варианты и расширить `sync-state`:

```ts
  // --- Фигурки-игроки ---
  // Добавить ИЛИ обновить фигурку (upsert по id: смена команды/подписи/позиции).
  | { t: "fig-add"; epoch: number; fig: Figure }
  // Переместить фигурку (во время драга шлётся батчами через RAF).
  | { t: "fig-move"; epoch: number; id: string; x: number; y: number }
  // Удалить одну фигурку.
  | { t: "fig-del"; epoch: number; id: string }
  // --- Стрелки ---
  | { t: "arrow-add"; epoch: number; arrow: Arrow }
  | { t: "arrow-del"; epoch: number; id: string }
```

Изменить вариант `sync-state` на:

```ts
  | { t: "sync-state"; epoch: number; strokes: Stroke[]; bg: string | null; bgVer: number; figures?: Figure[]; arrows?: Arrow[] };
```

Обновить doc-комментарий над union: упомянуть, что фигурки/стрелки тоже несут `epoch` и чистятся вместе со штрихами.

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- board`
Expected: PASS. Также `npx tsc --noEmit` не должен давать новых ошибок в `board.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "feat(board): сообщения fig-*/arrow-* и фигурки/стрелки в снапшоте"
```

---

## Фаза 2 — Библиотека карт

### Task 5: Манифест карт CS2

**Files:**
- Create: `src/lib/maps.ts`
- Test: `src/lib/maps.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_MAP_RE`, `sanitizeBgUrl` из `@/lib/board`.
- Produces: `type GameMap = { id: string; name: string; src: string; aspect: number }`; `CS2_MAPS: GameMap[]`.

- [ ] **Step 1: Написать падающий тест**

`src/lib/maps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CS2_MAPS } from "@/lib/maps";
import { BUILTIN_MAP_RE, sanitizeBgUrl } from "@/lib/board";

describe("CS2_MAPS", () => {
  it("непустой и с уникальными id", () => {
    expect(CS2_MAPS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(CS2_MAPS.map((m) => m.id)).size).toBe(CS2_MAPS.length);
  });
  it("каждый src проходит вайтлист фона и имеет положительный aspect", () => {
    for (const m of CS2_MAPS) {
      expect(BUILTIN_MAP_RE.test(m.src)).toBe(true);
      expect(sanitizeBgUrl(m.src)).toBe(m.src);
      expect(m.aspect).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- maps`
Expected: FAIL — модуль `@/lib/maps` не найден.

- [ ] **Step 3: Реализовать `src/lib/maps.ts`**

```ts
// Встроенная библиотека карт. Старт — CS2. Чтобы добавить другую игру,
// заведи ещё один такой массив; формат тот же.
//
// src — корне-относительный путь к радару в public/ (проходит BUILTIN_MAP_RE в
// board.ts). Радары CS2 квадратные, поэтому aspect = 1: рамка знает пропорции
// заранее, без скачка вёрстки при загрузке картинки.

export type GameMap = { id: string; name: string; src: string; aspect: number };

export const CS2_MAPS: GameMap[] = [
  { id: "mirage", name: "Mirage", src: "/maps/cs2/mirage.jpg", aspect: 1 },
  { id: "dust2", name: "Dust II", src: "/maps/cs2/dust2.jpg", aspect: 1 },
  { id: "inferno", name: "Inferno", src: "/maps/cs2/inferno.jpg", aspect: 1 },
  { id: "nuke", name: "Nuke", src: "/maps/cs2/nuke.jpg", aspect: 1 },
  { id: "overpass", name: "Overpass", src: "/maps/cs2/overpass.jpg", aspect: 1 },
  { id: "ancient", name: "Ancient", src: "/maps/cs2/ancient.jpg", aspect: 1 },
  { id: "anubis", name: "Anubis", src: "/maps/cs2/anubis.jpg", aspect: 1 },
  { id: "vertigo", name: "Vertigo", src: "/maps/cs2/vertigo.jpg", aspect: 1 },
  { id: "train", name: "Train", src: "/maps/cs2/train.jpg", aspect: 1 },
];
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- maps`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/maps.ts src/lib/maps.test.ts
git commit -m "feat(maps): манифест карт CS2"
```

---

### Task 6: Радар-ассеты карт

**Files:**
- Create: `public/maps/cs2/{mirage,dust2,inferno,nuke,overpass,ancient,anubis,vertigo,train}.jpg`

**Interfaces:** нет кода; задача — положить файлы, на которые ссылается `CS2_MAPS`.

- [ ] **Step 1: Сложить квадратные радар-миникарты**

Скачать публичные community-радары CS2 (по одному на карту из `CS2_MAPS`), привести к квадрату (1:1), вес ≤ ~300 КБ каждый, имена строго как в `src` манифеста. Положить в `public/maps/cs2/`.

> ⚠️ Лицензия: радары — ассеты Valve, редистрибуция в `public/` — серая зона (см. §9 спеки). Если потребуется — заменить на собственные схематичные. Решение принято осознанно владельцем проекта.

- [ ] **Step 2: Проверить наличие файлов**

Run: `ls public/maps/cs2/`
Expected: 9 файлов `.jpg`, имена совпадают с `m.src` каждого элемента `CS2_MAPS`.

- [ ] **Step 3: Прогнать тест манифеста (ссылки бьются с файлами)**

Run: `npm test -- maps`
Expected: PASS. Дополнительно проверить, что для каждого `m.src` существует файл:
`node -e "const{CS2_MAPS}=require('./src/lib/maps.ts')" ` не сработает (TS) — вместо этого глазами сверить `ls` со списком из Task 5.

- [ ] **Step 4: Коммит**

```bash
git add public/maps/cs2
git commit -m "feat(maps): радар-миникарты карт CS2"
```

---

## Фаза 3 — Боковой HUD-рельс и состояние инструмента

### Task 7: Иконки `move` и `arrow`

**Files:**
- Modify: `src/components/Icon.tsx`

**Interfaces:**
- Produces: `IconName` дополнен `"move"` и `"arrow"`.

- [ ] **Step 1: Добавить имена в union `IconName`**

В `IconName` (строки ~8-37) добавить `| "move"` и `| "arrow"`.

- [ ] **Step 2: Добавить пути в `PATHS`**

В объект `PATHS` добавить (стиль — обводка 24×24, как у соседей):

```tsx
  // четыре стрелки от центра — «перемещение»
  move: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </>
  ),
  // диагональная стрелка с наконечником — инструмент «стрелка»
  arrow: (
    <>
      <line x1="5" y1="19" x2="19" y2="5" />
      <path d="M10 5h9v9" />
    </>
  ),
```

- [ ] **Step 3: Проверка типов**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add src/components/Icon.tsx
git commit -m "feat(ui): иконки move и arrow для тулбара доски"
```

---

### Task 8: Компонент `BoardRail` (рельс + контекстный поповер)

**Files:**
- Create: `src/app/room/[code]/BoardRail.tsx`

**Interfaces:**
- Consumes: `Icon`, `IconName`; типы `StrokeMode`, `ArrowStyle` из `@/lib/board`.
- Produces:
  ```ts
  export type Tool = "move" | "draw" | "erase" | "arrow";
  export default function BoardRail(props: {
    tool: Tool; onTool: (t: Tool) => void;
    color: string; presetColors: string[]; onColor: (c: string) => void;
    size: number; minSize: number; maxSize: number; onSize: (n: number) => void;
    arrowStyle: ArrowStyle; onArrowStyle: (s: ArrowStyle) => void;
    onAddFigure: (team: "ct" | "t") => void;
    onClear: () => void;
  }): JSX.Element
  ```
  `Tool` — единый тип инструмента; `draw`/`erase` соответствуют существующему `StrokeMode`.

- [ ] **Step 1: Реализовать компонент**

```tsx
"use client";

import Icon, { type IconName } from "@/components/Icon";
import ElasticSlider from "@/components/ElasticSlider";
import type { ArrowStyle } from "@/lib/board";

export type Tool = "move" | "draw" | "erase" | "arrow";

const TOOLS: { id: Tool; icon: IconName; label: string }[] = [
  { id: "move", icon: "move", label: "Перемещение" },
  { id: "draw", icon: "pencil", label: "Кисть" },
  { id: "erase", icon: "eraser", label: "Ластик" },
  { id: "arrow", icon: "arrow", label: "Стрелка" },
];

/**
 * Боковой HUD-рельс доски (направление B): инструменты + спавн фигурок + очистка.
 * Контекстный поповер (цвет/толщина/тип стрелки) виден только для рисующих
 * инструментов — правило «не захламляем HUD» (DESIGN_SYSTEM §10).
 */
export default function BoardRail({
  tool, onTool, color, presetColors, onColor,
  size, minSize, maxSize, onSize, arrowStyle, onArrowStyle,
  onAddFigure, onClear,
}: {
  tool: Tool; onTool: (t: Tool) => void;
  color: string; presetColors: string[]; onColor: (c: string) => void;
  size: number; minSize: number; maxSize: number; onSize: (n: number) => void;
  arrowStyle: ArrowStyle; onArrowStyle: (s: ArrowStyle) => void;
  onAddFigure: (team: "ct" | "t") => void;
  onClear: () => void;
}) {
  const showColor = tool === "draw" || tool === "arrow";
  const showSize = tool === "draw" || tool === "erase";
  const showArrowStyle = tool === "arrow";
  const showPopover = showColor || showSize || showArrowStyle;

  return (
    <div className="pointer-events-none absolute left-2 top-2 z-[var(--z-dock,80)] flex items-start gap-2">
      {/* рельс инструментов */}
      <div className="pointer-events-auto flex flex-col gap-1 rounded-[var(--radius)] border border-border bg-surface/90 p-1.5 backdrop-blur">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTool(t.id)}
            aria-pressed={tool === t.id}
            aria-label={t.label}
            title={t.label}
            className={
              "flex h-11 w-11 items-center justify-center rounded-lg transition-colors " +
              (tool === t.id ? "bg-accent text-on-accent" : "text-text-dim hover:text-text")
            }
          >
            <Icon name={t.icon} size={20} />
          </button>
        ))}
        <div className="my-1 h-px bg-border" />
        <button
          onClick={() => onAddFigure("ct")}
          aria-label="Добавить игрока CT"
          title="Добавить CT"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ color: "#3aa0ff", border: "1.5px solid #3aa0ff80", background: "#3aa0ff1f" }}
        >
          CT
        </button>
        <button
          onClick={() => onAddFigure("t")}
          aria-label="Добавить игрока T"
          title="Добавить T"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ color: "#f5b70a", border: "1.5px solid #f5b70a80", background: "#f5b70a1f" }}
        >
          T
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          onClick={onClear}
          aria-label="Очистить доску"
          title="Очистить всё"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-text-dim hover:text-danger"
        >
          <Icon name="trash" size={20} />
        </button>
      </div>

      {/* контекстный поповер */}
      {showPopover && (
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-2 shadow-[var(--shadow-2)]">
          {showColor && (
            <div className="flex items-center gap-1.5">
              {presetColors.map((c) => (
                <button
                  key={c}
                  onClick={() => onColor(c)}
                  aria-label={`Цвет ${c}`}
                  aria-pressed={color === c}
                  className={
                    "h-6 w-6 rounded-full border-2 " +
                    (color === c ? "border-text" : "border-border-strong hover:scale-105")
                  }
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => onColor(e.target.value)}
                aria-label="Свой цвет"
                className="h-6 w-6 cursor-pointer rounded border border-border-strong bg-transparent p-0"
              />
            </div>
          )}
          {showSize && (
            <div className="flex items-center gap-2 text-sm text-text-dim">
              Толщина
              <ElasticSlider
                className="w-28"
                startingValue={minSize}
                maxValue={maxSize}
                defaultValue={size}
                isStepped
                stepSize={1}
                showValue
                onChange={onSize}
                ariaLabel="Толщина кисти"
              />
            </div>
          )}
          {showArrowStyle && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Тип стрелки">
              <button
                onClick={() => onArrowStyle("solid")}
                aria-pressed={arrowStyle === "solid"}
                className={"btn btn--sm" + (arrowStyle === "solid" ? " btn--primary" : "")}
              >
                Раш —
              </button>
              <button
                onClick={() => onArrowStyle("dashed")}
                aria-pressed={arrowStyle === "dashed"}
                className={"btn btn--sm" + (arrowStyle === "dashed" ? " btn--primary" : "")}
              >
                Ротация ╴╴
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверка типов**

Run: `npx tsc --noEmit`
Expected: без ошибок (компонент пока не подключён — это нормально).

- [ ] **Step 3: Коммит**

```bash
git add src/app/room/[code]/BoardRail.tsx
git commit -m "feat(board): боковой HUD-рельс инструментов (направление B)"
```

---

### Task 9: Подключить рельс к `TacticsBoard`, маршрутизация указателя по инструменту

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: `BoardRail`, `Tool` (Task 8).
- Produces: состояние `tool: Tool` и `arrowStyle: ArrowStyle` в `TacticsBoard`; canvas получает указатель только при `tool === "draw" | "erase"`.

Это переходная задача: старые контролы (ряды цвета/толщины/ластика/очистки/загрузки) заменяются рельсом; рисование кистью/ластиком продолжает работать через новый `tool`.

- [ ] **Step 1: Добавить состояние инструмента**

В импорты добавить `BoardRail, { type Tool }` и `type ArrowStyle`. Заменить состояние `mode`:

```tsx
// Раньше было: const [mode, setMode] = useState<StrokeMode>("draw");
const [tool, setTool] = useState<Tool>("draw");
const [arrowStyle, setArrowStyle] = useState<ArrowStyle>("solid");
// Режим штриха выводится из инструмента (кисть → draw, ластик → erase).
const strokeMode: StrokeMode = tool === "erase" ? "erase" : "draw";
```

Везде, где использовался `mode` для штриха (`handlePointerDown` создаёт `Stroke`, `pickColor` сбрасывал `mode`), заменить на `strokeMode`. В `handlePointerDown` стартовать штрих только когда `tool === "draw" || tool === "erase"`:

```tsx
function handlePointerDown(e: React.PointerEvent) {
  if (tool !== "draw" && tool !== "erase") return; // рисует только кисть/ластик
  if (e.button !== 0 && e.pointerType === "mouse") return;
  // … остальное без изменений, но stroke.mode = strokeMode
}
```

- [ ] **Step 2: Заменить старый тулбар на рельс в разметке**

Удалить два старых `<div className="flex flex-wrap …">` (ряд цвета/ластика/толщины/очистки и ряд загрузки карты) из `return`. Контейнер доски (`containerRef`) сделать `relative` (уже так) и вложить рельс первым ребёнком:

```tsx
<div ref={containerRef} className="stage relative w-full" style={{ aspectRatio: String(bgAspect ?? DEFAULT_ASPECT) }}>
  <BoardRail
    tool={tool}
    onTool={setTool}
    color={color}
    presetColors={PRESET_COLORS}
    onColor={pickColor}
    size={size}
    minSize={MIN_SIZE}
    maxSize={MAX_SIZE}
    onSize={changeSize}
    arrowStyle={arrowStyle}
    onArrowStyle={setArrowStyle}
    onAddFigure={() => {}}   {/* подключим в Task 12 */}
    onClear={clearBoard}
  />
  {bg && (/* <img> фон — без изменений */)}
  <canvas
    ref={canvasRef}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={handlePointerEnd}
    onPointerCancel={handlePointerEnd}
    onLostPointerCapture={handlePointerEnd}
    className={
      "absolute inset-0 h-full w-full touch-none " +
      (tool === "draw" || tool === "erase" ? "cursor-crosshair" : "pointer-events-none")
    }
  />
</div>
```

`pickColor` упростить (выбор цвета больше не трогает инструмент):

```tsx
function pickColor(c: string) {
  setColor(c);
  saveBoardColor(c);
}
```

Загрузку карты/ссылку (host-only блок) пока сохранить НАД доской — она переедет в `MapPicker` в Task 10. Если проще — оставить временно как есть; на работу рельса не влияет.

- [ ] **Step 3: Проверка типов и сборки**

Run: `npx tsc --noEmit && npm run lint`
Expected: без ошибок.

- [ ] **Step 4: Ручная проверка в дев-сервере**

Запустить превью (preview_start), открыть комнату, вкладку «Доска». Проверить:
- Рельс слева, 4 инструмента переключаются (виден `aria-pressed`/подсветка).
- При «Кисть»/«Ластик» — поповер с цветом/толщиной; рисование и стирание работают.
- При «Перемещение»/«Стрелка» — canvas не перехватывает указатель (поповер для стрелки показывает тип; для перемещения поповер пуст/скрыт).
Снять скриншот (preview_screenshot) для подтверждения.

- [ ] **Step 5: Коммит**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): подключить рельс, маршрутизация указателя по инструменту"
```

---

### Task 10: Компонент `MapPicker` (библиотека карт, host-only)

**Files:**
- Create: `src/app/room/[code]/MapPicker.tsx`
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: `CS2_MAPS`, `GameMap` из `@/lib/maps`; `Icon`.
- Produces:
  ```ts
  export default function MapPicker(props: {
    currentSrc: string | null;
    onPick: (map: GameMap) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Реализовать `MapPicker.tsx`**

```tsx
"use client";

import { useState } from "react";
import Icon from "@/components/Icon";
import { CS2_MAPS, type GameMap } from "@/lib/maps";

/** Чип-дропдаун выбора встроенной карты. Показывается только хосту. */
export default function MapPicker({
  currentSrc,
  onPick,
}: {
  currentSrc: string | null;
  onPick: (map: GameMap) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = CS2_MAPS.find((m) => m.src === currentSrc);

  return (
    <div className="absolute right-2 top-2 z-[var(--z-dropdown,100)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface/90 px-3 py-2 text-sm text-text backdrop-blur"
      >
        <Icon name="map" size={16} />
        {current ? current.name : "Выбрать карту"}
        <span className="text-text-mute">▾</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 mt-1 max-h-72 w-44 overflow-auto rounded-[var(--radius)] border border-border-strong bg-surface-2 p-1 shadow-[var(--shadow-2)]"
        >
          {CS2_MAPS.map((m) => (
            <li key={m.id}>
              <button
                role="option"
                aria-selected={m.src === currentSrc}
                onClick={() => { onPick(m); setOpen(false); }}
                className={
                  "flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-sm hover:bg-surface " +
                  (m.src === currentSrc ? "text-accent-hi" : "text-text-dim")
                }
              >
                {m.name}
                {m.src === currentSrc && <Icon name="check" size={15} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Подключить в `TacticsBoard` (host-only) и задавать aspect из манифеста**

В контейнер доски добавить (после `BoardRail`), показывать только хосту:

```tsx
{amHost && (
  <MapPicker
    currentSrc={bg}
    onPick={(m) => {
      setBgAspect(m.aspect);   // пропорции известны заранее — без скачка
      setBackground(m.src);    // существующая функция: версия + broadcast bg
    }}
  />
)}
```

Импортировать `MapPicker` и `type GameMap`. Существующий `setBackground(url)` уже шлёт `bg` по каналу — встроенная карта поедет всем (а `sanitizeBgUrl` теперь её пропускает, Task 3).

- [ ] **Step 3: Проверка типов**

Run: `npx tsc --noEmit && npm run lint`
Expected: без ошибок.

- [ ] **Step 4: Ручная проверка**

Превью: как хост открыть дропдаун, выбрать Mirage — фон встаёт, рамка квадратная. Во второй вкладке/сессии (не-хост) убедиться, что карта приехала и дропдаун не показан. Скриншот.

- [ ] **Step 5: Коммит**

```bash
git add src/app/room/[code]/MapPicker.tsx src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): библиотека карт CS2 (host-only выбор)"
```

---

## Фаза 4 — Фигурки

### Task 11: Чистые хелперы фигурок

**Files:**
- Create: `src/lib/boardFigures.ts`
- Test: `src/lib/boardFigures.test.ts`

**Interfaces:**
- Consumes: `Figure`, `Team` из `@/lib/board`.
- Produces: `nextFigureNumber(figures: Figure[], team: Team): number` — наименьший свободный номер 1..5 (или следующий, если все заняты); `genFigureId(identity: string, seq: number): string`.

- [ ] **Step 1: Написать падающий тест**

`src/lib/boardFigures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextFigureNumber, genFigureId } from "@/lib/boardFigures";
import type { Figure } from "@/lib/board";

const fig = (team: "ct" | "t", label: string): Figure => ({ id: label, team, label, x: 0, y: 0 });

describe("nextFigureNumber", () => {
  it("на пустой команде даёт 1", () => {
    expect(nextFigureNumber([], "ct")).toBe(1);
  });
  it("заполняет пропуск в нумерации", () => {
    expect(nextFigureNumber([fig("ct", "1"), fig("ct", "3")], "ct")).toBe(2);
  });
  it("игнорирует другую команду и нечисловые подписи", () => {
    expect(nextFigureNumber([fig("t", "1"), fig("ct", "Den")], "ct")).toBe(1);
  });
  it("после пятёрки продолжает 6", () => {
    const five = ["1", "2", "3", "4", "5"].map((l) => fig("t", l));
    expect(nextFigureNumber(five, "t")).toBe(6);
  });
});

describe("genFigureId", () => {
  it("склеивает identity и seq", () => {
    expect(genFigureId("abc", 7)).toBe("abc-fig-7");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- boardFigures`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/lib/boardFigures.ts`**

```ts
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
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -- boardFigures`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/boardFigures.ts src/lib/boardFigures.test.ts
git commit -m "feat(board): чистые хелперы нумерации/id фигурок"
```

---

### Task 12: `FigureLayer` — рендер, добавление, локальный драг

**Files:**
- Create: `src/app/room/[code]/FigureLayer.tsx`
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: `Figure` из `@/lib/board`.
- Produces:
  ```ts
  export const TEAM_STYLE: Record<"ct" | "t", { bg: string; bd: string; fg: string }>;
  export default function FigureLayer(props: {
    figures: Figure[];
    draggable: boolean;            // true только при tool === "move"
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onMove: (id: string, x: number, y: number) => void;     // во время драга (throttle — у родителя)
    onMoveEnd: (id: string, x: number, y: number) => void;  // на отпускании (коммит)
    onEditLabel: (id: string, label: string) => void;
    onDelete: (id: string) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Реализовать `FigureLayer.tsx`**

```tsx
"use client";

import { useRef } from "react";
import type { Figure } from "@/lib/board";

export const TEAM_STYLE: Record<"ct" | "t", { bg: string; bd: string; fg: string }> = {
  ct: { bg: "#3aa0ff", bd: "#bfe0ff", fg: "#04101f" },
  t: { bg: "#f5b70a", bd: "#ffe39a", fg: "#1a1205" },
};

/**
 * DOM-слой фигурок поверх доски. Указатель ловит только когда draggable (режим
 * «Перемещение»); иначе сквозной, чтобы рисовать кистью под фигурками.
 * Драг идёт по слою (нормируем координаты от его rect — он совпадает с рамкой).
 */
export default function FigureLayer({
  figures, draggable, selectedId, onSelect, onMove, onMoveEnd, onEditLabel, onDelete,
}: {
  figures: Figure[];
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd: (id: string, x: number, y: number) => void;
  onEditLabel: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const last = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  function norm(e: React.PointerEvent) {
    const r = layerRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return { x, y };
  }

  function down(e: React.PointerEvent, id: string) {
    if (!draggable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragId.current = id;
    onSelect(id);
  }
  function move(e: React.PointerEvent) {
    if (!dragId.current) return;
    const p = norm(e);
    last.current = p;
    onMove(dragId.current, p.x, p.y);
  }
  function up() {
    if (!dragId.current) return;
    onMoveEnd(dragId.current, last.current.x, last.current.y);
    dragId.current = null;
  }

  return (
    <div
      ref={layerRef}
      className={"absolute inset-0 " + (draggable ? "" : "pointer-events-none")}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={(e) => { if (e.target === layerRef.current) onSelect(null); }}
    >
      {figures.map((f) => {
        const s = TEAM_STYLE[f.team];
        const selected = f.id === selectedId;
        return (
          <div
            key={f.id}
            onPointerDown={(e) => down(e, f.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const next = window.prompt("Подпись фигурки:", f.label);
              if (next != null) onEditLabel(f.id, next);
            }}
            className="absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[13px] font-bold shadow-[0_2px_6px_rgba(0,0,0,.55)]"
            style={{
              left: `${f.x * 100}%`, top: `${f.y * 100}%`,
              background: s.bg, color: s.fg, border: `2px solid ${s.bd}`,
              boxShadow: selected ? "0 0 0 2px var(--text)" : undefined,
              cursor: draggable ? "grab" : "default",
              touchAction: "none",
            }}
          >
            {/^\d+$/.test(f.label) ? f.label : ""}
            {f.label && !/^\d+$/.test(f.label) && (
              <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-text [text-shadow:0_1px_2px_#000]">
                {f.label}
              </span>
            )}
            {selected && draggable && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                aria-label="Удалить фигурку"
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-[11px] text-white"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

> Примечание по подписи: число рисуем внутри кружка; нечисловой ник — снизу подписью (внутри кружок остаётся с номером команды визуально пустым — допустимо для v1). При желании позже развести «номер всегда в кружке + ник снизу».

- [ ] **Step 2: Состояние фигурок и добавление в `TacticsBoard`**

Импортировать `FigureLayer`, `type Figure`, `nextFigureNumber, genFigureId`. Добавить состояние и refs:

```tsx
const [figures, setFigures] = useState<Figure[]>([]);
const figuresRef = useRef<Figure[]>([]);          // источник правды для onMessage
const [selectedFigId, setSelectedFigId] = useState<string | null>(null);
const figSeq = useRef(0);
// Синхронизируем ref при каждом изменении state (onMessage читает ref).
useEffect(() => { figuresRef.current = figures; }, [figures]);
```

Функция добавления (локально + broadcast `fig-add`):

```tsx
const addFigure = useCallback((team: "ct" | "t") => {
  const fig: Figure = {
    id: genFigureId(identityRef.current, figSeq.current++),
    team,
    label: String(nextFigureNumber(figuresRef.current, team)),
    x: 0.5, y: 0.5,   // в центр доски
  };
  setFigures((prev) => [...prev, fig]);
  broadcast({ t: "fig-add", epoch: epochRef.current, fig });
}, [broadcast]);
```

Передать в `BoardRail`: `onAddFigure={addFigure}`. Отрендерить слой в контейнере доски ПОСЛЕ canvas (фигурки сверху):

```tsx
<FigureLayer
  figures={figures}
  draggable={tool === "move"}
  selectedId={selectedFigId}
  onSelect={setSelectedFigId}
  onMove={(id, x, y) => moveFigureLive(id, x, y)}     // Task 13
  onMoveEnd={(id, x, y) => moveFigureCommit(id, x, y)} // Task 13
  onEditLabel={(id, label) => editFigureLabel(id, label)} // ниже
  onDelete={(id) => deleteFigure(id)}                 // Task 14
/>
```

Правка подписи (re-broadcast `fig-add` как upsert) и временные заглушки move/delete (заменятся в 13/14):

```tsx
const upsertLocalFigure = useCallback((fig: Figure) => {
  setFigures((prev) => {
    const i = prev.findIndex((f) => f.id === fig.id);
    if (i === -1) return [...prev, fig];
    const next = prev.slice(); next[i] = fig; return next;
  });
}, []);

const editFigureLabel = useCallback((id: string, label: string) => {
  const cur = figuresRef.current.find((f) => f.id === id);
  if (!cur) return;
  const fig = { ...cur, label };
  upsertLocalFigure(fig);
  broadcast({ t: "fig-add", epoch: epochRef.current, fig });
}, [broadcast, upsertLocalFigure]);
```

- [ ] **Step 3: Приём `fig-add` в `onMessage`**

В `switch (msg.t)` добавить ветку (upsert по id, с проверкой epoch и потолка):

```tsx
case "fig-add": {
  const e = sanitizeClock(msg.epoch);
  if (e === null || e < epochRef.current) break;
  if (e > epochRef.current) { catchUpEpoch(e); }   // см. ниже
  const fig = sanitizeFigure(msg.fig);
  if (!fig) break;
  setFigures((prev) => {
    const i = prev.findIndex((f) => f.id === fig.id);
    if (i !== -1) { const n = prev.slice(); n[i] = fig; return n; }
    if (prev.length >= MAX_FIGURES) return prev;     // потолок
    return [...prev, fig];
  });
  break;
}
```

Добавить общий помощник «догнать эпоху» (чистит все слои) рядом с `redraw` и использовать его в существующих ветках `stroke`/`clear` тоже (рефактор по желанию; минимально — определить и звать в новых ветках):

```tsx
const catchUpEpoch = useCallback((e: number) => {
  epochRef.current = e;
  strokesRef.current = [];
  activeRef.current = null;
  setFigures([]); setArrows([]);   // setArrows появится в Фазе 5
  redraw();
}, [redraw]);
```

> Если Фаза 5 ещё не реализована, временно убрать `setArrows([])` из `catchUpEpoch` и вернуть в Task 16.

Импортировать `sanitizeFigure`, `MAX_FIGURES` из `@/lib/board`.

- [ ] **Step 4: Снапшот — отдавать и принимать фигурки**

В `sendSnapshot` в заголовочный пакет добавить фигурки/(стрелки в Фазе 5):

```tsx
broadcast(
  { t: "sync-state", epoch: epochRef.current, strokes: [], bg: bgRef.current, bgVer: bgVerRef.current,
    figures: figuresRef.current, arrows: arrowsRef.current /* [] до Фазы 5 */ },
  [to],
);
```

В ветке `sync-state` после обработки штрихов добавить мёрдж фигурок (берём по id, не теряем своё):

```tsx
if (msg.figures && e !== null && e >= epochRef.current) {
  const incoming = sanitizeFigures(msg.figures);
  setFigures((prev) => {
    const byId = new Map(prev.map((f) => [f.id, f]));
    for (const f of incoming) { if (byId.size < MAX_FIGURES || byId.has(f.id)) byId.set(f.id, f); }
    return Array.from(byId.values());
  });
}
```

Условие отправки снапшота расширить: `if (id && (strokesRef.current.length > 0 || bgRef.current || figuresRef.current.length > 0 || arrowsRef.current.length > 0)) sendSnapshot(id);`

Импортировать `sanitizeFigures`.

- [ ] **Step 5: Проверка типов, lint, ручная проверка**

Run: `npx tsc --noEmit && npm run lint`
Затем превью в двух вкладках: `+CT`/`+T` добавляют пронумерованные фигурки в центр, они появляются у второго участника; поздний вход подтягивает фигурки снапшотом; двойной клик меняет подпись и она синхронится. Скриншот.

- [ ] **Step 6: Коммит**

```bash
git add src/app/room/[code]/FigureLayer.tsx src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): фигурки — рендер, добавление, правка подписи, снапшот"
```

---

### Task 13: Перетаскивание фигурок с синхроном (`fig-move`, батч через RAF)

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: `FigureLayer` колбэки `onMove`/`onMoveEnd`.
- Produces: `moveFigureLive(id,x,y)` (локальный апдейт + throttled broadcast), `moveFigureCommit(id,x,y)` (финальный broadcast); приём `fig-move`.

- [ ] **Step 1: Локальное перемещение + батч отправки через RAF**

Добавить буфер последнего движения и RAF-флаш (аналогично штрихам):

```tsx
const figMovePending = useRef<Map<string, { x: number; y: number }>>(new Map());
const figRafRef = useRef<number | null>(null);

const flushFigMoves = useCallback(() => {
  figRafRef.current = null;
  for (const [id, p] of figMovePending.current) {
    broadcast({ t: "fig-move", epoch: epochRef.current, id, x: p.x, y: p.y });
  }
  figMovePending.current.clear();
}, [broadcast]);

const moveFigureLive = useCallback((id: string, x: number, y: number) => {
  // локально — сразу (плавно), по сети — батчем на следующий кадр
  setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)));
  figMovePending.current.set(id, { x, y });
  if (figRafRef.current == null) figRafRef.current = requestAnimationFrame(flushFigMoves);
}, [flushFigMoves]);

const moveFigureCommit = useCallback((id: string, x: number, y: number) => {
  setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)));
  broadcast({ t: "fig-move", epoch: epochRef.current, id, x, y });  // гарантированно финальная позиция
}, [broadcast]);
```

В cleanup-эффекте размонтирования отменять `figRafRef` (рядом с существующим `rafRef`):

```tsx
if (figRafRef.current != null) cancelAnimationFrame(figRafRef.current);
```

- [ ] **Step 2: Приём `fig-move`**

```tsx
case "fig-move": {
  const e = sanitizeClock(msg.epoch);
  if (e === null || e < epochRef.current) break;
  if (e > epochRef.current) { catchUpEpoch(e); break; }
  if (typeof msg.id !== "string") break;
  if (!isFiniteNum(msg.x) || !isFiniteNum(msg.y)) break;
  const x = clamp01(msg.x), y = clamp01(msg.y);
  setFigures((prev) => prev.map((f) => (f.id === msg.id ? { ...f, x, y } : f)));
  break;
}
```

`isFiniteNum` приватна в board.ts — заменить на проверку через уже импортированный `clamp01` после `Number.isFinite`: `if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) break;`.

- [ ] **Step 3: Проверка**

Run: `npx tsc --noEmit && npm run lint`
Превью в двух вкладках: тащишь фигурку в режиме «Перемещение» — у второго участника она едет плавно; на отпускании позиции совпадают. Канал не флудит (драг шлёт максимум 1 пакет на кадр). Скриншот/лог сети (preview_network).

- [ ] **Step 4: Коммит**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): перетаскивание фигурок с батч-синхроном fig-move"
```

---

### Task 14: Удаление фигурок (`fig-del`, ✕ и Delete)

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Produces: `deleteFigure(id)` (локально + broadcast `fig-del`); приём `fig-del`; обработчик клавиш Delete/Backspace для выделенной фигурки.

- [ ] **Step 1: Удаление локально + broadcast**

```tsx
const deleteFigure = useCallback((id: string) => {
  setFigures((prev) => prev.filter((f) => f.id !== id));
  setSelectedFigId((cur) => (cur === id ? null : cur));
  broadcast({ t: "fig-del", epoch: epochRef.current, id });
}, [broadcast]);
```

- [ ] **Step 2: Приём `fig-del`**

```tsx
case "fig-del": {
  const e = sanitizeClock(msg.epoch);
  if (e === null || e < epochRef.current) break;
  if (typeof msg.id !== "string") break;
  setFigures((prev) => prev.filter((f) => f.id !== msg.id));
  break;
}
```

- [ ] **Step 3: Клавиша Delete/Backspace удаляет выделенную фигурку**

Добавить эффект (активен, когда доска видима и что-то выделено):

```tsx
useEffect(() => {
  if (!active || !selectedFigId) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;   // не мешаем вводу
      e.preventDefault();
      deleteFigure(selectedFigId);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [active, selectedFigId, deleteFigure]);
```

- [ ] **Step 4: Проверка**

Run: `npx tsc --noEmit && npm run lint`
Превью: выделить фигурку (режим «Перемещение») → ✕ удаляет; Delete удаляет; у второго участника исчезает. Скриншот.

- [ ] **Step 5: Коммит**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): удаление фигурок (✕ и Delete) с синхроном"
```

---

## Фаза 5 — Стрелки

### Task 15: `ArrowLayer` — рендер и рисование резиновой прямой

**Files:**
- Create: `src/app/room/[code]/ArrowLayer.tsx`
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: `Arrow`, `ArrowStyle` из `@/lib/board`.
- Produces:
  ```ts
  export default function ArrowLayer(props: {
    arrows: Arrow[];
    drawing: boolean;                 // true при tool === "arrow"
    selecting: boolean;               // true при tool === "move"
    color: string; style: ArrowStyle;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onCommit: (a: { x1: number; y1: number; x2: number; y2: number }) => void;
    onDelete: (id: string) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Реализовать `ArrowLayer.tsx`**

```tsx
"use client";

import { useRef, useState } from "react";
import type { Arrow, ArrowStyle } from "@/lib/board";

/**
 * SVG-слой стрелок. В режиме «Стрелка» рисует резиновую прямую (превью локальное),
 * на отпускании отдаёт endpoints через onCommit. В режиме «Перемещение» — хит-тест
 * по линиям для выделения/удаления. Иначе указатель сквозной.
 */
export default function ArrowLayer({
  arrows, drawing, selecting, color, style, selectedId, onSelect, onCommit, onDelete,
}: {
  arrows: Arrow[];
  drawing: boolean;
  selecting: boolean;
  color: string; style: ArrowStyle;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (a: { x1: number; y1: number; x2: number; y2: number }) => void;
  onDelete: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  function norm(e: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }
  function down(e: React.PointerEvent) {
    if (!drawing) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = norm(e);
    setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }
  function move(e: React.PointerEvent) {
    if (!draft) return;
    const p = norm(e);
    setDraft((d) => (d ? { ...d, x2: p.x, y2: p.y } : d));
  }
  function up() {
    if (!draft) return;
    const moved = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 0.02; // отсекаем случайный тык
    if (moved) onCommit(draft);
    setDraft(null);
  }

  const pe = drawing || selecting ? "auto" : "none";

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: pe, touchAction: "none", cursor: drawing ? "crosshair" : "default" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <defs>
        {/* наконечник наследует цвет линии через context-fill недоступен в SVG1,
            поэтому маркер на стрелку генерим по id с нужным fill ниже */}
      </defs>
      {arrows.map((a) => {
        const mid = `ah-${a.id}`;
        const sel = a.id === selectedId;
        return (
          <g key={a.id}>
            <marker id={mid} markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L5,3 L0,6 Z" fill={a.color} />
            </marker>
            {/* широкая прозрачная линия — удобный хит-тест для выделения */}
            {selecting && (
              <line
                x1={a.x1 * 100} y1={a.y1 * 100} x2={a.x2 * 100} y2={a.y2 * 100}
                stroke="transparent" strokeWidth={3}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); onSelect(a.id); }}
              />
            )}
            <line
              x1={a.x1 * 100} y1={a.y1 * 100} x2={a.x2 * 100} y2={a.y2 * 100}
              stroke={a.color} strokeWidth={sel ? 1.4 : 1} strokeLinecap="round"
              strokeDasharray={a.style === "dashed" ? "3 2.4" : undefined}
              markerEnd={`url(#${mid})`}
              vectorEffect="non-scaling-stroke"
            />
            {sel && selecting && (
              <g
                transform={`translate(${(a.x1 + a.x2) / 2 * 100} ${(a.y1 + a.y2) / 2 * 100})`}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); onDelete(a.id); }}
              >
                <circle r="2.6" fill="var(--danger)" />
                <path d="M-1.2,-1.2 L1.2,1.2 M1.2,-1.2 L-1.2,1.2" stroke="#fff" strokeWidth="0.6" />
              </g>
            )}
          </g>
        );
      })}
      {draft && (
        <line
          x1={draft.x1 * 100} y1={draft.y1 * 100} x2={draft.x2 * 100} y2={draft.y2 * 100}
          stroke={color} strokeWidth={1} strokeLinecap="round"
          strokeDasharray={style === "dashed" ? "3 2.4" : undefined}
          vectorEffect="non-scaling-stroke" opacity={0.8}
        />
      )}
    </svg>
  );
}
```

> Замечание: `strokeWidth` задаём в координатах viewBox 0..100; `vectorEffect="non-scaling-stroke"` держит видимую толщину постоянной при растяжении. Толщина — фиксированная (стрелки не зависят от слайдера кисти).

- [ ] **Step 2: Состояние стрелок в `TacticsBoard` + рендер слоя (между canvas и фигурками)**

Импортировать `ArrowLayer`, `type Arrow`, `sanitizeArrow, sanitizeArrows, MAX_ARROWS`. Добавить состояние:

```tsx
const [arrows, setArrows] = useState<Arrow[]>([]);
const arrowsRef = useRef<Arrow[]>([]);
const [selectedArrowId, setSelectedArrowId] = useState<string | null>(null);
const arrowSeq = useRef(0);
useEffect(() => { arrowsRef.current = arrows; }, [arrows]);
```

Если в Task 12 в `catchUpEpoch` временно убирали `setArrows([])` — вернуть его сейчас.

Рендер слоя в контейнере доски ПОСЛЕ canvas и ПЕРЕД `FigureLayer`:

```tsx
<ArrowLayer
  arrows={arrows}
  drawing={tool === "arrow"}
  selecting={tool === "move"}
  color={color}
  style={arrowStyle}
  selectedId={selectedArrowId}
  onSelect={setSelectedArrowId}
  onCommit={addArrow}     // ниже
  onDelete={deleteArrow}  // Task 16
/>
```

Добавление стрелки:

```tsx
const addArrow = useCallback((g: { x1: number; y1: number; x2: number; y2: number }) => {
  const arrow: Arrow = {
    id: `${identityRef.current}-arr-${arrowSeq.current++}`,
    color, style: arrowStyle, ...g,
  };
  setArrows((prev) => (prev.length >= MAX_ARROWS ? prev : [...prev, arrow]));
  broadcast({ t: "arrow-add", epoch: epochRef.current, arrow });
}, [broadcast, color, arrowStyle]);
```

- [ ] **Step 3: Приём `arrow-add` + снапшот стрелок**

Ветка в `onMessage`:

```tsx
case "arrow-add": {
  const e = sanitizeClock(msg.epoch);
  if (e === null || e < epochRef.current) break;
  if (e > epochRef.current) { catchUpEpoch(e); }
  const arrow = sanitizeArrow(msg.arrow);
  if (!arrow) break;
  setArrows((prev) => {
    if (prev.some((a) => a.id === arrow.id)) return prev;   // идемпотентность
    if (prev.length >= MAX_ARROWS) return prev;
    return [...prev, arrow];
  });
  break;
}
```

В `sync-state` (приём) после фигурок:

```tsx
if (msg.arrows && e !== null && e >= epochRef.current) {
  const incoming = sanitizeArrows(msg.arrows);
  setArrows((prev) => {
    const byId = new Map(prev.map((a) => [a.id, a]));
    for (const a of incoming) { if (byId.size < MAX_ARROWS || byId.has(a.id)) byId.set(a.id, a); }
    return Array.from(byId.values());
  });
}
```

`sendSnapshot` уже шлёт `arrows: arrowsRef.current` (заложено в Task 12 Step 4).

- [ ] **Step 4: Проверка**

Run: `npx tsc --noEmit && npm run lint`
Превью в двух вкладках: инструмент «Стрелка», тип «Раш» — тянешь прямую, отпускаешь → сплошная стрелка с наконечником появляется у обоих; «Ротация» → пунктир; поздний вход подтягивает стрелки. Скриншот.

- [ ] **Step 5: Коммит**

```bash
git add src/app/room/[code]/ArrowLayer.tsx src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): стрелки — рисование, тип сплошная/пунктир, синхрон, снапшот"
```

---

### Task 16: Удаление стрелок (`arrow-del`)

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Produces: `deleteArrow(id)`; приём `arrow-del`; Delete/Backspace удаляет выделенную стрелку.

- [ ] **Step 1: Удаление локально + broadcast**

```tsx
const deleteArrow = useCallback((id: string) => {
  setArrows((prev) => prev.filter((a) => a.id !== id));
  setSelectedArrowId((cur) => (cur === id ? null : cur));
  broadcast({ t: "arrow-del", epoch: epochRef.current, id });
}, [broadcast]);
```

- [ ] **Step 2: Приём `arrow-del`**

```tsx
case "arrow-del": {
  const e = sanitizeClock(msg.epoch);
  if (e === null || e < epochRef.current) break;
  if (typeof msg.id !== "string") break;
  setArrows((prev) => prev.filter((a) => a.id !== msg.id));
  break;
}
```

- [ ] **Step 3: Расширить обработчик Delete на стрелки**

В эффекте из Task 14 Step 3 в обработчик `onKey` добавить удаление выделенной стрелки (и поправить зависимости `selectedArrowId`, `deleteArrow`):

```tsx
if (selectedFigId) deleteFigure(selectedFigId);
else if (selectedArrowId) deleteArrow(selectedArrowId);
```

Условие активации эффекта: `if (!active || (!selectedFigId && !selectedArrowId)) return;`

- [ ] **Step 4: Проверка**

Run: `npx tsc --noEmit && npm run lint`
Превью: в «Перемещении» кликнуть стрелку (выделилась, у середины ✕) → ✕ или Delete удаляет; у второго участника исчезает. Скриншот.

- [ ] **Step 5: Коммит**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): удаление стрелок с синхроном"
```

---

## Фаза 6 — «Очистить всё»

### Task 17: «Очистить» чистит штрихи + фигурки + стрелки

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Produces: `clearBoard` дополнительно сбрасывает фигурки/стрелки; приёмная ветка `clear` тоже.

- [ ] **Step 1: Расширить `clearBoard`**

```tsx
function clearBoard() {
  epochRef.current += 1;
  strokesRef.current = [];
  activeRef.current = null;
  setFigures([]);
  setArrows([]);
  setSelectedFigId(null);
  setSelectedArrowId(null);
  redraw();
  playSfx("board-clear");
  broadcast({ t: "clear", epoch: epochRef.current });
}
```

- [ ] **Step 2: Расширить приём `clear`**

В ветке `case "clear":` после `strokesRef.current = []` добавить `setFigures([]); setArrows([]); setSelectedFigId(null); setSelectedArrowId(null);` (внутри блока `if (e > epochRef.current)`).

> Если в Task 12 ввели `catchUpEpoch`, который уже чистит все слои — переиспользовать его здесь: заменить тело `if (e > epochRef.current) { … }` на `catchUpEpoch(e);`.

- [ ] **Step 3: Проверка**

Run: `npx tsc --noEmit && npm run lint && npm test`
Превью в двух вкладках: нарисовать штрихи, поставить фигурки, провести стрелки → «Очистить» убирает всё у обоих; поздний вход после очистки приходит на пустую доску. Скриншот.

- [ ] **Step 4: Коммит**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): «Очистить» убирает штрихи, фигурки и стрелки"
```

---

## Финальная проверка

- [ ] **Прогнать весь тест-сьют:** `npm test` — все зелёные.
- [ ] **Типы и линт:** `npx tsc --noEmit && npm run lint` — чисто.
- [ ] **Сборка:** `npm run build` — успешна.
- [ ] **Сквозной сценарий в двух вкладках:** выбрать карту (хост) → расставить CT/T → потащить фигурки (плавно у второго) → подписать ника → нарисовать раш (сплошная) и ротацию (пунктир) → удалить одну фигурку и одну стрелку → поздний вход в третьей вкладке видит полное состояние → «Очистить» обнуляет у всех. Скриншоты ключевых шагов.

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- §3 слои (canvas/svg/dom, маршрутизация по инструменту) → Task 9, 12, 15.
- §4 протокол (Figure/Arrow, сообщения, лимиты, санитайзеры, sync-state) → Task 1–4.
- §5 карты (манифест, ассеты, вайтлист, чип host-only) → Task 3, 5, 6, 10.
- §6 UX (спавн+номера, драг, подпись, рисование стрелки, удаление, очистить) → Task 12–17.
- §7 рельс направления B + контекстный поповер → Task 8, 9.
- §8 структура файлов → отражена в File Structure (с уточнением про `useBoardChannel`).
- §9 риски (лицензия карт, флуд fig-move, ре-рендер) → Task 6 (пометка), Task 13 (RAF-батч).

**Плейсхолдеры:** временные заглушки `onAddFigure={() => {}}` (Task 9) и move/delete (Task 12) явно помечены как заменяемые в последующих задачах — это упорядоченная передача интерфейса между задачами, а не «TODO без кода».

**Согласованность типов:** `Tool` (move/draw/erase/arrow), `Figure`, `Arrow`, `ArrowStyle`, `TEAM_STYLE`, `nextFigureNumber/genFigureId`, `catchUpEpoch`, `addFigure/moveFigureLive/moveFigureCommit/deleteFigure/addArrow/deleteArrow` — имена согласованы между задачами-производителями и потребителями. `fig-add` везде трактуется как upsert по id.
