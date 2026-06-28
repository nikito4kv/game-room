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

/** Команда фигурки: CT или T. */
export type Team = "ct" | "t";

/** Фигурка-игрок на доске. Координаты — нормированные 0..1. */
export type Figure = { id: string; team: Team; label: string; x: number; y: number };

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

// --- Жёсткие лимиты приёма ---
// Данные приходят от других участников (у всех есть canPublishData), поэтому
// размеры тоже нельзя оставлять без верхней границы — иначе один пир может
// раздуть память/CPU у всех (DoS) или «заморозить» доску гигантским счётчиком.
/** Потолок счётчика epoch/ver: больше — отбрасываем (защита от «заморозки»). */
export const MAX_CLOCK = 1_000_000;
/** Максимум точек в одном штрихе на приёме (лишние отбрасываются). */
export const MAX_POINTS_PER_STROKE = 10_000;
/** Максимум штрихов (в сообщении и всего на доске). */
export const MAX_STROKES = 5_000;
/** Максимальная длина id штриха. */
export const MAX_ID_LEN = 64;
/** Максимум фигурок-игроков на доске. */
export const MAX_FIGURES = 50;
/** Максимальная длина подписи фигурки. */
export const MAX_LABEL_LEN = 16;

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

/** Корректный CSS-цвет в hex: ровно 3/4/6/8 цифр (#rgb/#rgba/#rrggbb/#rrggbbaa).
 *  Длины 5 и 7 — НЕ валидный CSS, и canvas молча рисовал бы прежним цветом. */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}

/**
 * Валидный логический счётчик (epoch/ver): конечное неотрицательное целое в
 * разумных пределах. null — если вне диапазона: тогда сообщение отбрасывается, и
 * злоумышленник не «замораживает» доску гигантским epoch (Number.isFinite(1e308)
 * === true, поэтому одной проверки на конечность мало).
 */
export function sanitizeClock(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < 0 || v > MAX_CLOCK) return null;
  return v;
}

/** Возвращает цвет, если он валидный hex, иначе fallback. */
export function safeColor(v: unknown, fallback: string): string {
  return isHexColor(v) ? v : fallback;
}

function isTeam(v: unknown): v is Team {
  return v === "ct" || v === "t";
}

/** Чистая подпись: убираем управляющие символы/переводы строк, trim, обрезаем по длине. */
export function safeLabel(v: unknown): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex -- намеренно вырезаем управляющие символы из недоверенного ввода
  return v.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_LABEL_LEN);
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

/** Отфильтровывает только корректные точки из произвольного входа (с кэпом). */
export function sanitizePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const p of raw) {
    const point = sanitizePoint(p);
    if (point) out.push(point);
    if (out.length >= MAX_POINTS_PER_STROKE) break; // защита от гигантских пакетов
  }
  return out;
}

/** Приводит произвольный объект к корректному Stroke или возвращает null. */
export function sanitizeStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id || s.id.length > MAX_ID_LEN) return null;
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

/** Приводит входной массив штрихов (снимок доски) к корректным Stroke[] (с кэпом). */
export function sanitizeStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const s of raw) {
    const stroke = sanitizeStroke(s);
    if (stroke) out.push(stroke);
    if (out.length >= MAX_STROKES) break; // защита от переполнения доски
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
