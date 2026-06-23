// Протокол доски тактик. Используется и при отправке, и при приёме сообщений
// через data-канал LiveKit — держим типы в одном месте, чтобы стороны не
// разъехались. Это клиентский модуль (без серверных секретов).

/** Точка штриха в НОРМАЛИЗОВАННЫХ координатах 0..1 относительно рамки доски.
 *  Нормализация нужна, чтобы линии совпадали при разных размерах холста. */
export type Point = [x: number, y: number];

export type StrokeMode = "draw" | "erase";

/** Один штрих (мазок кистью или ластиком) от нажатия до отпускания. */
export type Stroke = {
  id: string;
  color: string;
  /** Толщина в долях ширины доски (0..1), чтобы масштабироваться вместе с ней. */
  size: number;
  mode: StrokeMode;
  points: Point[];
};

/**
 * Сообщения, летящие по data-каналу под топиком "board".
 *
 * Версионирование (чтобы поздние/повторные пакеты не «воскрешали» стёртое):
 * - `epoch` — счётчик очисток доски. Каждая «Очистить» увеличивает его. Штрихи и
 *   снимки несут epoch; всё с epoch меньше текущего игнорируется.
 * - `ver` — версия фона. Каждая смена/снятие фона увеличивает его; применяется
 *   только пакет с бóльшим ver (так корректно доезжает и снятие фона).
 */
export type BoardMessage =
  // Инкрементальное продолжение штриха: точки ДОПИСЫВАЮТСЯ к штриху с этим id.
  | { t: "stroke"; epoch: number; id: string; color: string; size: number; mode: StrokeMode; points: Point[] }
  // Очистить все штрихи (фон остаётся). Несёт новый epoch.
  | { t: "clear"; epoch: number }
  // Сменить/снять фон-карту (по каналу летит только URL, не сама картинка).
  | { t: "bg"; ver: number; url: string | null }
  // Поздно зашедший просит текущее состояние доски.
  | { t: "sync-req" }
  // Снимок доски в ответ на sync-req (шлётся адресно). Может приходить частями
  // (стримим штрихи кусками, чтобы не упереться в лимит размера пакета WebRTC) —
  // штрихи сливаются по id, поэтому несколько частей применяются безопасно.
  | { t: "sync-state"; epoch: number; strokes: Stroke[]; bg: string | null; bgVer: number };

/** Топик data-канала, под которым живут все сообщения доски. */
export const BOARD_TOPIC = "board";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Кодирует сообщение доски в байты для publishData. */
export function encodeBoardMessage(msg: BoardMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

/** Декодирует входящие байты. null — если payload не разобрался (битый пакет). */
export function decodeBoardMessage(payload: Uint8Array): BoardMessage | null {
  try {
    return JSON.parse(decoder.decode(payload)) as BoardMessage;
  } catch {
    return null;
  }
}

// --- Валидация входящих данных ---
// Сообщения приходят от других участников (у всех есть canPublishData), поэтому
// доверять форме нельзя: кривой/злонамеренный пакет не должен ронять отрисовку.

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Зажимает число в 0..1 — единый домен нормированных координат и толщины. */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Корректный CSS-цвет в hex (#rgb..#rrggbbaa). Иначе — false. */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);
}

/** Возвращает цвет, если он валидный hex, иначе fallback. */
export function safeColor(v: unknown, fallback: string): string {
  return isHexColor(v) ? v : fallback;
}

/**
 * Квантуем координату до 4 знаков (~0.1px на доске 1000px) — точности с запасом,
 * зато точка сериализуется коротко (~16 байт), и снимок предсказуемо влезает в
 * лимит пакета. Полная точность float раздувала бы JSON в разы.
 */
export function quantizeCoord(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Точка [x,y] с числами 0..1. Возвращает null, если форма не та. */
function sanitizePoint(raw: unknown): Point | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [x, y] = raw;
  if (!isFiniteNum(x) || !isFiniteNum(y)) return null;
  return [clamp01(x), clamp01(y)];
}

/** Отфильтровывает только корректные точки из произвольного входа. */
export function sanitizePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const p of raw) {
    const point = sanitizePoint(p);
    if (point) out.push(point);
  }
  return out;
}

/** Приводит произвольный объект к корректному Stroke или возвращает null. */
export function sanitizeStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) return null;
  const points = sanitizePoints(s.points);
  if (points.length === 0) return null;
  return {
    id: s.id,
    color: safeColor(s.color, "#000000"),
    size: isFiniteNum(s.size) ? clamp01(s.size) : 0.004,
    mode: s.mode === "erase" ? "erase" : "draw",
    points,
  };
}

/** Приводит входной массив штрихов (снимок доски) к корректным Stroke[]. */
export function sanitizeStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const s of raw) {
    const stroke = sanitizeStroke(s);
    if (stroke) out.push(stroke);
  }
  return out;
}

/**
 * Разрешаем как фон только http(s)/data:image — чтобы по data-каналу нельзя было
 * подсунуть произвольную строку (защита от CSS-инъекций и javascript:-схем).
 * Возвращает безопасный URL или null.
 */
export function sanitizeBgUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url;
  return null;
}
