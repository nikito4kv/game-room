# CS2 Game Objects (Grenades) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a game-aware grenade layer to the tactics board — smoke/molotov/HE effect zones and flash/decoy point icons, each with an optional throw-line (origin → landing) and a timing label, synced live across the room.

**Architecture:** A third board entity type alongside `Figure`/`Arrow`. Wire protocol + sanitizers live in `src/lib/board.ts`; a data-driven catalog + pure geometry helpers in `src/lib/boardObjects.ts`; a DOM rendering/interaction layer `GObjectLayer.tsx` mirroring `FigureLayer`; tool UI in `BoardRail.tsx`; orchestration/sync in `TacticsBoard.tsx`. Reuses the existing LiveKit data channel (`board` topic), `epoch` clock, snapshot/reconnect flow, RAF drag batching, and input validation.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, LiveKit data channel, Vitest, Tailwind utility classes + design-system CSS vars.

## Global Constraints

- All incoming messages come from other participants — **validate shape before applying** (every `gobj-*` branch and snapshot merge sanitizes). One peer must not be able to crash or freeze others' boards.
- Coordinates are **normalized 0..1** relative to the board rect; use `normToRect`/`clamp01`. Never store pixel coords.
- All object messages carry the current `epoch`; a larger epoch triggers a full board clear (`catchUpEpoch`). Objects clear together with strokes/figures/arrows.
- Hard receive limits: `MAX_OBJECTS = 40`, `MAX_NOTE_LEN = 24`, radius clamped to `MIN_OBJ_RADIUS = 0.02 .. MAX_OBJ_RADIUS = 0.25`. Reuse `MAX_ID_LEN = 64`.
- UI copy is **Russian** (matches existing board UI).
- Icons are house-style stroke glyphs in `Icon.tsx` (24×24 viewBox, `currentColor`, `strokeWidth=1.75`, round caps/joins). No external icon assets.
- Path alias `@/` → `src/`. Tests: `npx vitest run <file>`. Lint: `npm run lint`. Typecheck: `npx tsc --noEmit`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/board.ts` *(modify)* | Wire types (`GameObject`, `ObjKind`, `ObjClass`, `Technique`), `gobj-*` message variants, `objects` in `sync-state`, sanitizers, limits |
| `src/lib/boardObjects.ts` *(create)* | Catalog `CS2_OBJECTS`, lookups `objDef`/`objClass`, `genObjectId`, technique labels, `ObjGeom` + pure `applyGeom` |
| `src/components/Icon.tsx` *(modify)* | 5 grenade stroke glyphs + union members |
| `src/app/room/[code]/GObjectLayer.tsx` *(create)* | DOM layer: render zones/icons/lines/labels, placement click, drag (landing/origin/radius), timing popover, delete |
| `src/app/room/[code]/BoardRail.tsx` *(modify)* | `nade` tool + grenade-kind picker popover |
| `src/app/room/[code]/TacticsBoard.tsx` *(modify)* | Object state, add/move/edit/delete, `onMessage` branches, snapshot, clear, selection exclusivity, render `GObjectLayer` |
| `src/lib/board.test.ts` *(modify)* | Object sanitizer + limit tests, gobj-add roundtrip |
| `src/lib/boardObjects.test.ts` *(create)* | Catalog, id, `applyGeom` tests |

---

## Task 1: Protocol types, sanitizers & limits in `board.ts`

**Files:**
- Modify: `src/lib/board.ts`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: existing `clamp01`, `isFiniteNum`, `MAX_ID_LEN`, `encodeBoardMessage`/`decodeBoardMessage`.
- Produces:
  - `type ObjKind = "smoke" | "flash" | "molotov" | "he" | "decoy"`
  - `type ObjClass = "zone" | "icon"`
  - `type Technique = "stand" | "jump" | "runjump" | "move"`
  - `type GameObject = { id: string; kind: ObjKind; x: number; y: number; radius?: number; from?: { x: number; y: number }; technique?: Technique; note?: string }`
  - `isObjKind(v): v is ObjKind`, `isTechnique(v): v is Technique`, `safeNote(v): string`
  - `sanitizeGameObject(raw): GameObject | null`, `sanitizeGameObjects(raw): GameObject[]`
  - Constants `MAX_OBJECTS=40`, `MAX_NOTE_LEN=24`, `MIN_OBJ_RADIUS=0.02`, `MAX_OBJ_RADIUS=0.25`
  - `BoardMessage` gains `gobj-add` / `gobj-move` / `gobj-del`; `sync-state` gains `objects?: GameObject[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/board.test.ts` (and add the new symbols to the existing import block at the top of that file):

```ts
import {
  isObjKind,
  isTechnique,
  safeNote,
  sanitizeGameObject,
  sanitizeGameObjects,
  MAX_OBJECTS,
  MAX_NOTE_LEN,
  MIN_OBJ_RADIUS,
  MAX_OBJ_RADIUS,
  encodeBoardMessage,
  decodeBoardMessage,
} from "@/lib/board";

describe("isObjKind / isTechnique", () => {
  it("принимает только известные значения", () => {
    expect(isObjKind("smoke")).toBe(true);
    expect(isObjKind("he")).toBe(true);
    expect(isObjKind("nuke")).toBe(false);
    expect(isObjKind(7)).toBe(false);
    expect(isTechnique("jump")).toBe(true);
    expect(isTechnique("fly")).toBe(false);
  });
});

describe("safeNote", () => {
  it("чистит управляющие символы, тримит и режет по длине", () => {
    expect(safeNote("  1.6с\n ")).toBe("1.6с");
    expect(safeNote("a".repeat(40)).length).toBe(MAX_NOTE_LEN);
    expect(safeNote(123)).toBe("");
  });
});

describe("sanitizeGameObject", () => {
  const base = { id: "p1.ab-obj-0", kind: "smoke", x: 0.5, y: 0.5 };

  it("принимает корректный объект и зажимает координаты", () => {
    const o = sanitizeGameObject({ ...base, x: 2, y: -1 });
    expect(o).toEqual({ id: "p1.ab-obj-0", kind: "smoke", x: 1, y: 0 });
  });
  it("отвергает без id / с плохим kind / без координат", () => {
    expect(sanitizeGameObject({ ...base, id: "" })).toBeNull();
    expect(sanitizeGameObject({ ...base, kind: "bomb" })).toBeNull();
    expect(sanitizeGameObject({ ...base, x: "nope" })).toBeNull();
    expect(sanitizeGameObject(null)).toBeNull();
  });
  it("зажимает radius в пределах и игнорирует нечисловой", () => {
    expect(sanitizeGameObject({ ...base, radius: 99 })!.radius).toBe(MAX_OBJ_RADIUS);
    expect(sanitizeGameObject({ ...base, radius: 0 })!.radius).toBe(MIN_OBJ_RADIUS);
    expect(sanitizeGameObject({ ...base, radius: "x" })!.radius).toBeUndefined();
  });
  it("санитизирует from, technique и note; мусор отбрасывает", () => {
    const o = sanitizeGameObject({
      ...base,
      from: { x: 5, y: 0.2 },
      technique: "runjump",
      note: "  после фейка ",
    })!;
    expect(o.from).toEqual({ x: 1, y: 0.2 });
    expect(o.technique).toBe("runjump");
    expect(o.note).toBe("после фейка");
    const bad = sanitizeGameObject({ ...base, from: { x: "a" }, technique: "fly", note: "" })!;
    expect(bad.from).toBeUndefined();
    expect(bad.technique).toBeUndefined();
    expect(bad.note).toBeUndefined();
  });
});

describe("sanitizeGameObjects", () => {
  it("фильтрует мусор и режет по MAX_OBJECTS", () => {
    const many = Array.from({ length: MAX_OBJECTS + 10 }, (_, i) => ({
      id: `o${i}`, kind: "flash", x: 0.1, y: 0.1,
    }));
    expect(sanitizeGameObjects([...many, "junk", null]).length).toBe(MAX_OBJECTS);
    expect(sanitizeGameObjects("nope")).toEqual([]);
  });
});

describe("gobj-add roundtrip", () => {
  it("кодируется и декодируется без потерь", () => {
    const msg = {
      t: "gobj-add" as const,
      epoch: 3,
      obj: { id: "o1", kind: "molotov" as const, x: 0.2, y: 0.3, radius: 0.06 },
    };
    expect(decodeBoardMessage(encodeBoardMessage(msg))).toEqual(msg);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/board.test.ts`
Expected: FAIL — `isObjKind`, `sanitizeGameObject`, etc. are not exported.

- [ ] **Step 3: Implement types, constants, predicates and sanitizers**

In `src/lib/board.ts`, after the `Arrow` type block (around line 38) add:

```ts
/** Тип игрового объекта CS2 (граната). */
export type ObjKind = "smoke" | "flash" | "molotov" | "he" | "decoy";

/** Класс рендера: зона эффекта (круг) или точечная иконка. */
export type ObjClass = "zone" | "icon";

/** Техника броска для линии «откуда кидать». */
export type Technique = "stand" | "jump" | "runjump" | "move";

/**
 * Игровой объект на доске. Координаты — нормированные 0..1.
 * radius — только для zone-типов (доля ширины доски). from — точка броска
 * (при наличии рисуется линия). technique/note — подпись тайминга.
 */
export type GameObject = {
  id: string;
  kind: ObjKind;
  x: number;
  y: number;
  radius?: number;
  from?: { x: number; y: number };
  technique?: Technique;
  note?: string;
};
```

In the limits block (after `MAX_ARROWS`, around line 95) add:

```ts
/** Максимум игровых объектов на доске. */
export const MAX_OBJECTS = 40;
/** Максимальная длина заметки тайминга. */
export const MAX_NOTE_LEN = 24;
/** Границы радиуса зоны эффекта (доля ширины доски). */
export const MIN_OBJ_RADIUS = 0.02;
export const MAX_OBJ_RADIUS = 0.25;
```

In the validation section (after `safeLabel`, around line 159) add:

```ts
const OBJ_KINDS: ObjKind[] = ["smoke", "flash", "molotov", "he", "decoy"];
export function isObjKind(v: unknown): v is ObjKind {
  return typeof v === "string" && (OBJ_KINDS as string[]).includes(v);
}

const TECHNIQUES: Technique[] = ["stand", "jump", "runjump", "move"];
export function isTechnique(v: unknown): v is Technique {
  return typeof v === "string" && (TECHNIQUES as string[]).includes(v);
}

/** Чистая заметка тайминга: режем управляющие символы, trim, обрезаем по длине. */
export function safeNote(v: unknown): string {
  if (typeof v !== "string") return "";
  // Намеренно вырезаем управляющие символы (0x00–0x1F, 0x7F) из недоверенного ввода.
  return v.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_NOTE_LEN);
}

function sanitizeFromPoint(raw: unknown): { x: number; y: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  if (!isFiniteNum(f.x) || !isFiniteNum(f.y)) return undefined;
  return { x: clamp01(f.x), y: clamp01(f.y) };
}

/** Приводит произвольный объект к корректному GameObject или возвращает null. */
export function sanitizeGameObject(raw: unknown): GameObject | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id.length > MAX_ID_LEN) return null;
  if (!isObjKind(o.kind)) return null;
  if (!isFiniteNum(o.x) || !isFiniteNum(o.y)) return null;
  const obj: GameObject = { id: o.id, kind: o.kind, x: clamp01(o.x), y: clamp01(o.y) };
  if (isFiniteNum(o.radius)) {
    obj.radius = Math.min(MAX_OBJ_RADIUS, Math.max(MIN_OBJ_RADIUS, o.radius));
  }
  const from = sanitizeFromPoint(o.from);
  if (from) obj.from = from;
  if (isTechnique(o.technique)) obj.technique = o.technique;
  const note = safeNote(o.note);
  if (note) obj.note = note;
  return obj;
}

/** Приводит входной массив объектов к корректным GameObject[] (с кэпом MAX_OBJECTS). */
export function sanitizeGameObjects(raw: unknown): GameObject[] {
  if (!Array.isArray(raw)) return [];
  const out: GameObject[] = [];
  for (const r of raw) {
    const o = sanitizeGameObject(r);
    if (o) out.push(o);
    if (out.length >= MAX_OBJECTS) break;
  }
  return out;
}
```

In the `BoardMessage` union (around lines 71–73), add the three object variants before the final `sync-state` line, and extend `sync-state`:

```ts
  // --- Игровые объекты (гранаты) ---
  // Добавить ИЛИ обновить объект (upsert по id: тип/техника/заметка/геометрия).
  | { t: "gobj-add"; epoch: number; obj: GameObject }
  // Патч геометрии во время драга (батчем на RAF). Применяются присутствующие поля.
  | { t: "gobj-move"; epoch: number; id: string; x?: number; y?: number; fromX?: number; fromY?: number; radius?: number }
  // Удалить один объект.
  | { t: "gobj-del"; epoch: number; id: string }
  | { t: "sync-state"; epoch: number; strokes: Stroke[]; bg: string | null; bgVer: number; figures?: Figure[]; arrows?: Arrow[]; objects?: GameObject[] };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/board.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "feat(board): протокол и санитайзеры игровых объектов CS2"
```

---

## Task 2: Catalog, id generator & geometry helper in `boardObjects.ts`

**Files:**
- Create: `src/lib/boardObjects.ts`
- Modify: `src/components/Icon.tsx`
- Test: `src/lib/boardObjects.test.ts`

**Interfaces:**
- Consumes: `GameObject`, `ObjKind`, `ObjClass`, `Technique`, `clamp01`, `MIN_OBJ_RADIUS`, `MAX_OBJ_RADIUS` from `@/lib/board`; `IconName` from `@/components/Icon`.
- Produces:
  - `type ObjKindDef = { kind: ObjKind; name: string; cls: ObjClass; color: string; icon: IconName; defaultRadius?: number }`
  - `CS2_OBJECTS: ObjKindDef[]`, `objDef(kind): ObjKindDef`, `objClass(kind): ObjClass`
  - `genObjectId(identity, seq): string` → `` `${identity}-obj-${seq}` ``
  - `TECHNIQUE_LABELS: { id: Technique; label: string }[]`
  - `type ObjGeom = { x?: number; y?: number; fromX?: number; fromY?: number; radius?: number }`
  - `applyGeom(o: GameObject, g: ObjGeom): GameObject` (clamps coords/radius, builds `from`)
  - `Icon` gains glyphs `nade-smoke | nade-molotov | nade-he | nade-flash | nade-decoy`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/boardObjects.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CS2_OBJECTS,
  objDef,
  objClass,
  genObjectId,
  applyGeom,
} from "@/lib/boardObjects";
import { MAX_OBJ_RADIUS, MIN_OBJ_RADIUS, type GameObject } from "@/lib/board";

describe("CS2_OBJECTS catalog", () => {
  it("zone-типы имеют defaultRadius, icon-типы — нет", () => {
    for (const d of CS2_OBJECTS) {
      if (d.cls === "zone") expect(typeof d.defaultRadius).toBe("number");
      else expect(d.defaultRadius).toBeUndefined();
    }
  });
  it("objDef/objClass находят по kind", () => {
    expect(objClass("smoke")).toBe("zone");
    expect(objClass("flash")).toBe("icon");
    expect(objDef("he").color).toMatch(/^#/);
  });
});

describe("genObjectId", () => {
  it("склеивает identity и seq", () => {
    expect(genObjectId("p1.ab", 4)).toBe("p1.ab-obj-4");
  });
});

describe("applyGeom", () => {
  const o: GameObject = { id: "o1", kind: "smoke", x: 0.5, y: 0.5, radius: 0.07 };
  it("патчит координаты и зажимает", () => {
    expect(applyGeom(o, { x: 2, y: -1 })).toMatchObject({ x: 1, y: 0 });
  });
  it("строит from из частичного патча", () => {
    expect(applyGeom(o, { fromX: 0.2, fromY: 0.3 }).from).toEqual({ x: 0.2, y: 0.3 });
  });
  it("зажимает radius в пределах", () => {
    expect(applyGeom(o, { radius: 99 }).radius).toBe(MAX_OBJ_RADIUS);
    expect(applyGeom(o, { radius: 0 }).radius).toBe(MIN_OBJ_RADIUS);
  });
  it("не трогает поля, которых нет в патче", () => {
    const r = applyGeom(o, { x: 0.6 });
    expect(r.radius).toBe(0.07);
    expect(r.y).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/boardObjects.test.ts`
Expected: FAIL — module `@/lib/boardObjects` not found.

- [ ] **Step 3: Add grenade glyphs to `Icon.tsx`**

In `src/components/Icon.tsx`, extend the `IconName` union (after `"send"`):

```ts
  | "send"
  | "nade-smoke"
  | "nade-molotov"
  | "nade-he"
  | "nade-flash"
  | "nade-decoy";
```

In the `PATHS` record, add before the closing `}`:

```tsx
  // облако дыма
  "nade-smoke": (
    <path d="M6.5 16a3.5 3.5 0 0 1 .4-7 4.5 4.5 0 0 1 8.7-1.1A3.2 3.2 0 0 1 17 16z" />
  ),
  // язык пламени (молотов)
  "nade-molotov": (
    <path d="M12 3c2.2 3 3.8 4.3 3.8 7.8A3.8 3.8 0 0 1 8.2 11c0-1.6.8-2.7 1.8-3.6.4 1 .9 1.5 1.8 2-.6-2.1-.1-3.9.4-6.4z" />
  ),
  // осколочная: корпус + рычаг
  "nade-he": (
    <>
      <circle cx="12" cy="14" r="5.5" />
      <path d="M11 8.6V6.5h3.2L16 4.8" />
    </>
  ),
  // вспышка: лучи из центра
  "nade-flash": (
    <>
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2.4 2.4M15.6 15.6 18 18M18 6l-2.4 2.4M8.4 15.6 6 18" />
    </>
  ),
  // дэкой: корпус гранаты + звуковая волна
  "nade-decoy": (
    <>
      <circle cx="11" cy="13" r="5" />
      <path d="M10 8V6h3" />
      <path d="M17.5 9a4 4 0 0 1 0 6" />
    </>
  ),
```

- [ ] **Step 4: Create `src/lib/boardObjects.ts`**

```ts
// Каталог игровых объектов CS2 + чистые хелперы (вынесены для юнит-тестов).
// Чтобы добавить другую игру, заведи ещё один такой массив; формат тот же.
import type { IconName } from "@/components/Icon";
import {
  clamp01,
  MAX_OBJ_RADIUS,
  MIN_OBJ_RADIUS,
  type GameObject,
  type ObjClass,
  type ObjKind,
  type Technique,
} from "@/lib/board";

export type ObjKindDef = {
  kind: ObjKind;
  name: string;        // русское имя для UI
  cls: ObjClass;
  color: string;       // hex заливки/иконки
  icon: IconName;
  defaultRadius?: number; // для zone-типов
};

export const CS2_OBJECTS: ObjKindDef[] = [
  { kind: "smoke",   name: "Смок",    cls: "zone", color: "#cdd6df", icon: "nade-smoke",   defaultRadius: 0.07 },
  { kind: "molotov", name: "Молотов", cls: "zone", color: "#ff8a1e", icon: "nade-molotov", defaultRadius: 0.06 },
  { kind: "he",      name: "HE",      cls: "zone", color: "#ffb02e", icon: "nade-he",      defaultRadius: 0.05 },
  { kind: "flash",   name: "Флеш",    cls: "icon", color: "#dcefff", icon: "nade-flash" },
  { kind: "decoy",   name: "Дэкой",   cls: "icon", color: "#34d399", icon: "nade-decoy" },
];

const BY_KIND = Object.fromEntries(CS2_OBJECTS.map((d) => [d.kind, d])) as Record<ObjKind, ObjKindDef>;

export function objDef(kind: ObjKind): ObjKindDef {
  return BY_KIND[kind];
}
export function objClass(kind: ObjKind): ObjClass {
  return BY_KIND[kind].cls;
}

/** Стабильный id объекта: identity автора + растущий счётчик. */
export function genObjectId(identity: string, seq: number): string {
  return `${identity}-obj-${seq}`;
}

/** Чипы техники броска для UI. */
export const TECHNIQUE_LABELS: { id: Technique; label: string }[] = [
  { id: "stand",   label: "Стоя" },
  { id: "jump",    label: "Прыжок" },
  { id: "runjump", label: "Разбег+прыжок" },
  { id: "move",    label: "В движении" },
];

/** Патч геометрии объекта (живой драг и коммит используют один формат). */
export type ObjGeom = { x?: number; y?: number; fromX?: number; fromY?: number; radius?: number };

/**
 * Применяет патч геометрии к объекту: зажимает координаты/радиус, собирает from
 * из частичных полей. Чистая функция — общий код для отправителя и получателя.
 */
export function applyGeom(o: GameObject, g: ObjGeom): GameObject {
  const next: GameObject = { ...o };
  if (g.x != null) next.x = clamp01(g.x);
  if (g.y != null) next.y = clamp01(g.y);
  if (g.fromX != null || g.fromY != null) {
    const fx = g.fromX != null ? g.fromX : next.from?.x ?? next.x;
    const fy = g.fromY != null ? g.fromY : next.from?.y ?? next.y;
    next.from = { x: clamp01(fx), y: clamp01(fy) };
  }
  if (g.radius != null) {
    next.radius = Math.min(MAX_OBJ_RADIUS, Math.max(MIN_OBJ_RADIUS, g.radius));
  }
  return next;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/boardObjects.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/boardObjects.ts src/lib/boardObjects.test.ts src/components/Icon.tsx
git commit -m "feat(board): каталог объектов CS2, глифы гранат, applyGeom"
```

---

## Task 3: `GObjectLayer.tsx` — render & interaction layer

**Files:**
- Create: `src/app/room/[code]/GObjectLayer.tsx`

**Interfaces:**
- Consumes: `GameObject`, `Technique`, `normToRect` from `@/lib/board`; `objClass`, `objDef`, `TECHNIQUE_LABELS`, `type ObjGeom` from `@/lib/boardObjects`; `Icon`.
- Produces (component prop contract used by Task 5):
  - `placing: boolean` — `nade` tool active; click on empty space places an object
  - `onPlace(x: number, y: number): void`
  - `draggable: boolean`, `selectedId: string | null`, `onSelect(id|null)`
  - `onGeom(id, g: ObjGeom)` (live), `onGeomEnd(id, g: ObjGeom)` (commit)
  - `onEdit(id, patch: { technique?: Technique; note?: string })`, `onDelete(id)`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useRef, useState } from "react";
import { normToRect, type GameObject, type Technique } from "@/lib/board";
import { objClass, objDef, TECHNIQUE_LABELS, type ObjGeom } from "@/lib/boardObjects";
import Icon from "@/components/Icon";

type DragPart = "landing" | "from" | "radius";

/**
 * DOM-слой игровых объектов поверх доски (по образцу FigureLayer). Зоны эффекта —
 * круглые div с radial-gradient (aspect-ratio:1 + ширина в % держат круг при любых
 * пропорциях карты). Линии броска — общий SVG под объектами. Указатель ловится
 * только при placing (ставим) или draggable (двигаем/правим); иначе сквозной.
 */
export default function GObjectLayer({
  objects, placing, onPlace, draggable, selectedId, onSelect, onGeom, onGeomEnd, onEdit, onDelete,
}: {
  objects: GameObject[];
  placing: boolean;
  onPlace: (x: number, y: number) => void;
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGeom: (id: string, g: ObjGeom) => void;
  onGeomEnd: (id: string, g: ObjGeom) => void;
  onEdit: (id: string, patch: { technique?: Technique; note?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; part: DragPart } | null>(null);
  const last = useRef<ObjGeom>({});
  const moved = useRef(false);
  const [editId, setEditId] = useState<string | null>(null);

  function norm(e: React.PointerEvent) {
    const [x, y] = normToRect(e.clientX, e.clientY, layerRef.current!.getBoundingClientRect());
    return { x, y };
  }

  // Клик по пустому слою: в режиме «Граната» — поставить; в «Перемещении» — снять выделение.
  function layerDown(e: React.PointerEvent) {
    if (e.target !== layerRef.current) return;
    if (placing) {
      const p = norm(e);
      onPlace(p.x, p.y);
    } else if (draggable) {
      onSelect(null);
      setEditId(null);
    }
  }

  function startDrag(e: React.PointerEvent, id: string, part: DragPart) {
    if (!draggable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, part };
    last.current = {};
    moved.current = false;
    onSelect(id);
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const obj = objects.find((o) => o.id === d.id);
    if (!obj) return;
    const p = norm(e);
    let patch: ObjGeom;
    if (d.part === "landing") patch = { x: p.x, y: p.y };
    else if (d.part === "from") patch = { fromX: p.x, fromY: p.y };
    else patch = { radius: Math.hypot(p.x - obj.x, p.y - obj.y) };
    last.current = patch;
    moved.current = true;
    onGeom(d.id, patch);
  }

  function up() {
    const d = drag.current;
    if (!d) return;
    if (moved.current) onGeomEnd(d.id, last.current);
    drag.current = null;
  }

  const pe = placing || draggable;

  return (
    <div
      ref={layerRef}
      className={"absolute inset-0 " + (pe ? "" : "pointer-events-none")}
      style={{ cursor: placing ? "crosshair" : "default", touchAction: "none" }}
      onPointerDown={layerDown}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {/* Линии броска (общий SVG под маркерами). preserveAspectRatio="none" +
          non-scaling-stroke держат толщину постоянной — как в ArrowLayer. */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {objects.map((o) =>
          o.from ? (
            <g key={`l-${o.id}`}>
              <marker id={`oah-${o.id}`} markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L5,3 L0,6 Z" fill={objDef(o.kind).color} />
              </marker>
              <line
                x1={o.from.x * 100} y1={o.from.y * 100} x2={o.x * 100} y2={o.y * 100}
                stroke={objDef(o.kind).color} strokeWidth={1.2} strokeLinecap="round"
                strokeDasharray="3 2.4" markerEnd={`url(#oah-${o.id})`} vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null,
        )}
      </svg>

      {objects.map((o) => {
        const def = objDef(o.kind);
        const isZone = objClass(o.kind) === "zone";
        const selected = o.id === selectedId;
        const r = o.radius ?? 0.05;
        return (
          <div key={o.id}>
            {/* Зона эффекта */}
            {isZone && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                  width: `${r * 2 * 100}%`, aspectRatio: "1",
                  background: `radial-gradient(circle, ${def.color}e6 0%, ${def.color}b3 55%, ${def.color}1f 100%)`,
                  border: `1px dashed ${def.color}`,
                  boxShadow: selected ? "0 0 0 2px var(--text)" : undefined,
                  pointerEvents: "none",
                }}
              />
            )}

            {/* Маркер-иконка в точке приземления (он же ручка перетаскивания landing) */}
            <div
              onPointerDown={(e) => startDrag(e, o.id, "landing")}
              onDoubleClick={(e) => { e.stopPropagation(); if (draggable) setEditId(o.id); }}
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-[0_2px_6px_rgba(0,0,0,.55)]"
              style={{
                left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                background: "#0c131c", color: def.color, border: `2px solid ${def.color}`,
                boxShadow: selected && !isZone ? "0 0 0 2px var(--text)" : undefined,
                cursor: draggable ? "grab" : "default",
              }}
            >
              <Icon name={def.icon} size={16} />
            </div>

            {/* Точка броска (если есть) — перетаскиваемая ручка */}
            {o.from && (
              <div
                onPointerDown={(e) => startDrag(e, o.id, "from")}
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                style={{
                  left: `${o.from.x * 100}%`, top: `${o.from.y * 100}%`,
                  background: "#131c27", borderColor: def.color,
                  cursor: draggable ? "grab" : "default", pointerEvents: draggable ? "auto" : "none",
                }}
              />
            )}

            {/* Подпись тайминга у середины линии (или под маркером, если линии нет) */}
            {(o.technique || o.note) && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-semibold text-text"
                style={{
                  left: `${(o.from ? (o.from.x + o.x) / 2 : o.x) * 100}%`,
                  top: `${(o.from ? (o.from.y + o.y) / 2 : o.y + r + 0.02) * 100}%`,
                  pointerEvents: "none",
                }}
              >
                {[o.technique && TECHNIQUE_LABELS.find((t) => t.id === o.technique)?.label, o.note].filter(Boolean).join(" · ")}
              </div>
            )}

            {/* Ручки на выделенном объекте в режиме «Перемещение» */}
            {selected && draggable && (
              <>
                {/* ручка-хвост (создать линию) — если from ещё нет */}
                {!o.from && (
                  <div
                    onPointerDown={(e) => startDrag(e, o.id, "from")}
                    title="Тянуть — задать точку броска"
                    className="absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-surface text-text-dim"
                    style={{ left: `calc(${o.x * 100}% - 22px)`, top: `calc(${o.y * 100}% - 22px)`, cursor: "crosshair" }}
                  >
                    <Icon name="arrow" size={12} />
                  </div>
                )}
                {/* ручка радиуса (только зоны) */}
                {isZone && (
                  <div
                    onPointerDown={(e) => startDrag(e, o.id, "radius")}
                    title="Тянуть — радиус зоны"
                    className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--text)] bg-[var(--accent)]"
                    style={{ left: `calc(${o.x * 100}% + ${r * Math.SQRT1_2 * 200}%)`, top: `calc(${o.y * 100}% - ${r * Math.SQRT1_2 * 200}%)`, cursor: "nwse-resize" }}
                  />
                )}
                {/* удалить */}
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onDelete(o.id); }}
                  aria-label="Удалить объект"
                  className="absolute flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-danger text-[11px] text-white"
                  style={{ left: `calc(${o.x * 100}% + 14px)`, top: `calc(${o.y * 100}% - 14px)` }}
                >
                  ✕
                </button>
              </>
            )}

            {/* Поповер тайминга (двойной клик) */}
            {editId === o.id && draggable && (
              <div
                className="absolute z-[var(--z-dock,80)] -translate-x-1/2 rounded-[var(--radius)] border border-border-strong bg-surface p-2 shadow-[var(--shadow-2)]"
                style={{ left: `${o.x * 100}%`, top: `calc(${o.y * 100}% + 18px)` }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label="Техника броска">
                  {TECHNIQUE_LABELS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onEdit(o.id, { technique: o.technique === t.id ? undefined : t.id })}
                      aria-pressed={o.technique === t.id}
                      className={"btn btn--sm" + (o.technique === t.id ? " btn--primary" : "")}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  defaultValue={o.note ?? ""}
                  placeholder="Заметка / тайминг"
                  maxLength={24}
                  onBlur={(e) => onEdit(o.id, { note: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="field w-44"
                />
                <button onClick={() => setEditId(null)} className="btn btn--sm mt-1.5 w-full">Готово</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Lint & typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors for `GObjectLayer.tsx`. (The file is not yet rendered anywhere — wiring happens in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add src/app/room/[code]/GObjectLayer.tsx
git commit -m "feat(board): слой игровых объектов — зоны, иконки, линии, ручки, тайминг"
```

---

## Task 4: `nade` tool + kind picker in `BoardRail.tsx`

**Files:**
- Modify: `src/app/room/[code]/BoardRail.tsx`

**Interfaces:**
- Consumes: `CS2_OBJECTS` from `@/lib/boardObjects`; `Icon`; existing `ObjKind` type via props.
- Produces: `Tool` union gains `"nade"`; `BoardRail` props gain `objKind: ObjKind` and `onObjKind(k: ObjKind): void`.

- [ ] **Step 1: Extend the Tool type and tool list**

In `src/app/room/[code]/BoardRail.tsx`:

- Update imports:

```tsx
import Icon, { type IconName } from "@/components/Icon";
import ElasticSlider from "@/components/ElasticSlider";
import { TEAM_COLORS, type ArrowStyle, type ObjKind } from "@/lib/board";
import { CS2_OBJECTS, objDef } from "@/lib/boardObjects";
```

- Change the `Tool` type:

```tsx
export type Tool = "move" | "draw" | "erase" | "arrow" | "nade";
```

- Add a tool entry to `TOOLS` (after the `arrow` entry):

```tsx
  { id: "nade", icon: "nade-he", label: "Граната" },
```

- [ ] **Step 2: Add props and the kind popover**

- Extend the destructured props and the prop type:

```tsx
export default function BoardRail({
  tool, onTool, color, presetColors, onColor,
  size, minSize, maxSize, onSize, arrowStyle, onArrowStyle,
  objKind, onObjKind,
  onAddFigure, onClear,
}: {
  tool: Tool; onTool: (t: Tool) => void;
  color: string; presetColors: string[]; onColor: (c: string) => void;
  size: number; minSize: number; maxSize: number; onSize: (n: number) => void;
  arrowStyle: ArrowStyle; onArrowStyle: (s: ArrowStyle) => void;
  objKind: ObjKind; onObjKind: (k: ObjKind) => void;
  onAddFigure: (team: "ct" | "t") => void;
  onClear: () => void;
}) {
```

- Add a flag alongside the existing `show*` flags:

```tsx
  const showKinds = tool === "nade";
  const showPopover = showColor || showSize || showArrowStyle || showKinds;
```

- In the contextual popover, add the kind picker after the `showArrowStyle` block (before the popover's closing `</div>`):

```tsx
          {showKinds && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Тип гранаты">
              {CS2_OBJECTS.map((d) => (
                <button
                  key={d.kind}
                  onClick={() => onObjKind(d.kind)}
                  aria-pressed={objKind === d.kind}
                  title={d.name}
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold"
                  style={{
                    color: d.color,
                    border: `1.5px solid ${d.color}${objKind === d.kind ? "" : "66"}`,
                    background: objKind === d.kind ? `${d.color}26` : "transparent",
                  }}
                >
                  <Icon name={objDef(d.kind).icon} size={15} />
                  {d.name}
                </button>
              ))}
            </div>
          )}
```

- [ ] **Step 3: Lint & typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: errors only in `TacticsBoard.tsx` (it renders `<BoardRail>` without the new required `objKind`/`onObjKind` props yet — fixed in Task 5). `BoardRail.tsx` itself is clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/room/[code]/BoardRail.tsx
git commit -m "feat(board): инструмент «Граната» и выбор типа в рельсе"
```

---

## Task 5: Wire objects into `TacticsBoard.tsx`

**Files:**
- Modify: `src/app/room/[code]/TacticsBoard.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–4 — `GameObject`, `ObjKind`, `Technique`, `MAX_OBJECTS`, `safeNote`, `sanitizeGameObject`, `sanitizeGameObjects` from `@/lib/board`; `applyGeom`, `genObjectId`, `objDef`, `type ObjGeom` from `@/lib/boardObjects`; `GObjectLayer`; `BoardRail` (now needs `objKind`/`onObjKind`).
- Produces: end-to-end synced grenade objects.

- [ ] **Step 1: Add imports**

In the `@/lib/board` import block add: `MAX_OBJECTS`, `safeNote`, `sanitizeGameObject`, `sanitizeGameObjects`, and types `GameObject`, `ObjKind`, `Technique`. Add new module imports:

```tsx
import { applyGeom, genObjectId, objDef, type ObjGeom } from "@/lib/boardObjects";
import GObjectLayer from "./GObjectLayer";
```

- [ ] **Step 2: Add object state (near the arrows state block, ~line 119–126)**

```tsx
  // Игровые объекты (гранаты). Та же схема: ref для onMessage, state для рендера.
  const [objects, setObjects] = useState<GameObject[]>([]);
  const objectsRef = useRef<GameObject[]>([]);
  const [selectedObjId, setSelectedObjId] = useState<string | null>(null);
  const [objKind, setObjKind] = useState<ObjKind>("smoke");
  const objSeq = useRef(0);
  const objMovePending = useRef<Map<string, ObjGeom>>(new Map());
  const objRafRef = useRef<number | null>(null);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);
```

- [ ] **Step 3: Clear objects on epoch catch-up and on clearBoard**

In `catchUpEpoch` (~line 231) add alongside the other layer resets:

```tsx
      setObjects([]);
      setSelectedObjId(null);
```

In `clearBoard` (~line 822) add alongside the other resets:

```tsx
    setObjects([]);
    setSelectedObjId(null);
```

- [ ] **Step 4: Cancel object RAF on unmount**

In the unmount cleanup effect (~line 639) add:

```tsx
      if (objRafRef.current != null) cancelAnimationFrame(objRafRef.current);
```

- [ ] **Step 5: Add object CRUD callbacks (after the arrows section, ~line 738)**

```tsx
  // --- Игровые объекты: добавление, геометрия (драг), правка, удаление ---
  const addObject = useCallback(
    (kind: ObjKind, x: number, y: number) => {
      const id = genObjectId(`${identityRef.current}.${mountTag.current}`, objSeq.current++);
      const def = objDef(kind);
      const obj: GameObject = { id, kind, x, y };
      if (def.cls === "zone") obj.radius = def.defaultRadius;
      setObjects((prev) => (prev.length >= MAX_OBJECTS ? prev : [...prev, obj]));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj });
      setSelectedObjId(id);
    },
    [broadcast],
  );

  // Живой драг: батч-патч на кадр (как fig-move) — и локально, и по сети.
  const flushObjMoves = useCallback(() => {
    objRafRef.current = null;
    const pending = objMovePending.current;
    if (pending.size === 0) return;
    setObjects((prev) => prev.map((o) => (pending.has(o.id) ? applyGeom(o, pending.get(o.id)!) : o)));
    for (const [id, g] of pending) {
      broadcast({ t: "gobj-move", epoch: epochRef.current, id, ...g });
    }
    pending.clear();
  }, [broadcast]);

  const objGeomLive = useCallback(
    (id: string, g: ObjGeom) => {
      const cur = objMovePending.current.get(id) ?? {};
      objMovePending.current.set(id, { ...cur, ...g });
      if (objRafRef.current == null) objRafRef.current = requestAnimationFrame(flushObjMoves);
    },
    [flushObjMoves],
  );

  // Коммит финальной геометрии: применяем к объекту и шлём авторитетный gobj-add.
  const objGeomCommit = useCallback(
    (id: string, g: ObjGeom) => {
      objMovePending.current.delete(id);
      const cur = objectsRef.current.find((o) => o.id === id);
      if (!cur) return;
      const next = applyGeom(cur, g);
      setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj: next });
    },
    [broadcast],
  );

  const editObject = useCallback(
    (id: string, patch: { technique?: Technique; note?: string }) => {
      const cur = objectsRef.current.find((o) => o.id === id);
      if (!cur) return;
      const next: GameObject = { ...cur };
      if ("technique" in patch) next.technique = patch.technique;
      if ("note" in patch) {
        const n = safeNote(patch.note);
        next.note = n || undefined;
      }
      setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj: next });
    },
    [broadcast],
  );

  const deleteObject = useCallback(
    (id: string) => {
      setObjects((prev) => prev.filter((o) => o.id !== id));
      setSelectedObjId((cur) => (cur === id ? null : cur));
      broadcast({ t: "gobj-del", epoch: epochRef.current, id });
    },
    [broadcast],
  );

  const selectObject = useCallback((id: string | null) => {
    setSelectedObjId(id);
    if (id !== null) { setSelectedFigId(null); setSelectedArrowId(null); }
  }, []);
```

- [ ] **Step 6: Make selection mutually exclusive across all three layers**

Replace `selectFigure` and `selectArrow` (~line 742–749) so each clears the object selection too:

```tsx
  const selectFigure = useCallback((id: string | null) => {
    setSelectedFigId(id);
    if (id !== null) { setSelectedArrowId(null); setSelectedObjId(null); }
  }, []);
  const selectArrow = useCallback((id: string | null) => {
    setSelectedArrowId(id);
    if (id !== null) { setSelectedFigId(null); setSelectedObjId(null); }
  }, []);
```

- [ ] **Step 7: Extend the Delete/Backspace handler**

Replace the key-handler effect guard and body (~line 752–764) to include objects:

```tsx
  useEffect(() => {
    if (!active || (!selectedFigId && !selectedArrowId && !selectedObjId)) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      ev.preventDefault();
      if (selectedFigId) deleteFigure(selectedFigId);
      else if (selectedArrowId) deleteArrow(selectedArrowId);
      else if (selectedObjId) deleteObject(selectedObjId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selectedFigId, selectedArrowId, selectedObjId, deleteFigure, deleteArrow, deleteObject]);
```

- [ ] **Step 8: Add object branches to `onMessage`**

In the `switch (msg.t)` block, after the `arrow-del` case (~line 467), add:

```tsx
        case "gobj-add": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e);
          const obj = sanitizeGameObject(msg.obj);
          if (!obj) break;
          setObjects((prev) => {
            const i = prev.findIndex((o) => o.id === obj.id);
            if (i !== -1) { const n = prev.slice(); n[i] = obj; return n; }
            if (prev.length >= MAX_OBJECTS) return prev;
            return [...prev, obj];
          });
          break;
        }
        case "gobj-move": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) { catchUpEpoch(e); break; }
          if (typeof msg.id !== "string") break;
          const g: ObjGeom = {};
          if (Number.isFinite(msg.x)) g.x = msg.x as number;
          if (Number.isFinite(msg.y)) g.y = msg.y as number;
          if (Number.isFinite(msg.fromX)) g.fromX = msg.fromX as number;
          if (Number.isFinite(msg.fromY)) g.fromY = msg.fromY as number;
          if (Number.isFinite(msg.radius)) g.radius = msg.radius as number;
          setObjects((prev) => prev.map((o) => (o.id === msg.id ? applyGeom(o, g) : o)));
          break;
        }
        case "gobj-del": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e);
          if (typeof msg.id !== "string") break;
          setObjects((prev) => prev.filter((o) => o.id !== msg.id));
          break;
        }
```

In the `sync-state` case, after the arrows-merge block (~line 545), add an objects-merge block:

```tsx
          // Объекты из снапшота — слияние по id (не старее нашей последней очистки).
          if (msg.objects && e !== null && e >= epochRef.current) {
            const incoming = sanitizeGameObjects(msg.objects);
            setObjects((prev) => {
              const byId = new Map(prev.map((o) => [o.id, o]));
              for (const o of incoming) {
                if (byId.size < MAX_OBJECTS || byId.has(o.id)) byId.set(o.id, o);
              }
              return Array.from(byId.values());
            });
          }
```

- [ ] **Step 9: Include objects in the snapshot send & sync-req trigger**

In `sendSnapshot`'s header message (~line 314–324) add `objects`:

```tsx
          figures: figuresRef.current,
          arrows: arrowsRef.current,
          objects: objectsRef.current,
```

In the `sync-req` case condition (~line 489–495) add objects so a board with only objects still answers:

```tsx
            (strokesRef.current.length > 0 ||
              bgRef.current ||
              figuresRef.current.length > 0 ||
              arrowsRef.current.length > 0 ||
              objectsRef.current.length > 0)
```

- [ ] **Step 10: Render `GObjectLayer` and pass new `BoardRail` props**

Pass the kind props to `<BoardRail>` (~line 928, alongside `arrowStyle`/`onArrowStyle`):

```tsx
          objKind={objKind}
          onObjKind={setObjKind}
```

Add `<GObjectLayer>` between the `<canvas>` and `<ArrowLayer>` (so objects sit under arrows/figures) — insert right after the `</canvas>`'s closing (i.e., after the `<canvas .../>` element, ~line 979):

```tsx
        <GObjectLayer
          objects={objects}
          placing={tool === "nade"}
          onPlace={(x, y) => addObject(objKind, x, y)}
          draggable={tool === "move"}
          selectedId={selectedObjId}
          onSelect={selectObject}
          onGeom={objGeomLive}
          onGeomEnd={objGeomCommit}
          onEdit={editObject}
          onDelete={deleteObject}
        />
```

- [ ] **Step 11: Lint, typecheck, unit tests**

Run: `npm run lint && npx tsc --noEmit && npx vitest run`
Expected: all clean / green.

- [ ] **Step 12: Verify end-to-end in the running app**

Start the dev server (preview tooling) and open the room in **two tabs**, both joined.

1. Tab A: pick **Граната** tool → popover shows 5 kinds → choose **Смок** → click the map. Both tabs show a smoke zone at the same spot.
2. Switch A to **Перемещение**, select the smoke, drag the tail handle → throw-line appears and the origin handle is draggable; the radius handle resizes the zone. All mirrored live on B.
3. Double-click the smoke → pick **Прыжок**, type `1.6с` → label shows on both tabs.
4. Place **Флеш** (point icon) and **HE**/**Молотов** (zones) — correct per-type colors/render.
5. **Очистить** removes objects together with strokes/figures/arrows on both tabs.
6. Open a **third** tab → on join it receives all existing objects via snapshot.

Capture a screenshot of the board with a smoke + throw-line + label as proof.

- [ ] **Step 13: Commit**

```bash
git add src/app/room/[code]/TacticsBoard.tsx
git commit -m "feat(board): синхронизация игровых объектов CS2 (add/move/edit/del, снапшот)"
```

---

## Self-Review

**1. Spec coverage**

- Two visual classes (zone vs icon) → catalog `cls` + `GObjectLayer` render branch (Tasks 2, 3). ✓
- Grenades smoke/flash/molotov/HE/decoy → `ObjKind` + `CS2_OBJECTS` (Tasks 1, 2). ✓
- Throw-line (straight, dashed, arrow) via stamp + tail handle → `from` + SVG line + handle (Task 3). ✓
- Timing: technique chips + free note → `Technique`/`note`, `TECHNIQUE_LABELS`, popover (Tasks 1–3). ✓
- Data-driven catalog → `CS2_OBJECTS` array (Task 2). ✓
- Sync protocol gobj-add/move/del + snapshot `objects` → board.ts + TacticsBoard (Tasks 1, 5). ✓
- epoch clears objects with the board → `catchUpEpoch`/`clearBoard` (Task 5 Step 3). ✓
- Sanitizers + limits (MAX_OBJECTS, note len, radius clamp, kind/technique whitelist) → Task 1. ✓
- DOM layer like FigureLayer; order under arrows/figures → Task 5 Step 10. ✓
- Color by kind, not team → catalog colors (Task 2). ✓
- Rail tool + kind popover → Task 4. ✓
- Mutually-exclusive selection + Delete key → Task 5 Steps 6–7. ✓
- Icons: house-style stroke glyphs (plan refinement — replaces external CC BY assets; no attribution file). Flagged to user. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**3. Type consistency:** `ObjGeom`, `applyGeom`, `genObjectId`, `objDef`/`objClass`, `GameObject`, `ObjKind`, `Technique`, `MAX_OBJECTS`, `MIN_OBJ_RADIUS`/`MAX_OBJ_RADIUS`, `safeNote`, `sanitizeGameObject(s)` used identically across Tasks 1–5. `Tool` union extended once (Task 4) and consumed in Task 5. `gobj-move` geom fields all optional in the type (Task 1) and guarded with `Number.isFinite` on receive (Task 5). ✓
