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
  // Требуем ОБЕ оси: честный отправитель всегда шлёт fromX+fromY вместе. Иначе
  // частичный/злонамеренный пакет с одной осью сфабриковал бы точку броска (вторую
  // ось взяв из позиции объекта) и нарисовал линию объекта самому к себе.
  if (g.fromX != null && g.fromY != null) {
    next.from = { x: clamp01(g.fromX), y: clamp01(g.fromY) };
  }
  if (g.radius != null) {
    next.radius = Math.min(MAX_OBJ_RADIUS, Math.max(MIN_OBJ_RADIUS, g.radius));
  }
  return next;
}
