// Звуки интерфейса (sfx) — СИНТЕЗ на Web Audio, без файлов и без лицензий.
// Стиль «как в Discord»: мягкие округлые тоны на чистых синусах, плавная атака и
// затухание (нет щелчков → не режет слух), приятные музыкальные интервалы, лёгкий
// low-pass для теплоты. Всё параметрами — высоту/длину/громкость любого звука
// можно подкрутить здесь же.
//
// Модуль-синглтон (состояние на уровне модуля, не в React): один AudioContext на
// вкладку переживает SPA-навигацию Next, поэтому «выход» доигрывает после
// router.push, когда компонент комнаты уже размонтирован.
//
// Громкость/вкл-выкл — источник правды в localStorage (см. clientStorage), здесь
// держим горячую копию. Настройки правит SettingsModal через сеттеры.

import {
  getSfxEnabled,
  getSfxVolume,
  setSfxEnabled as persistEnabled,
  setSfxVolume as persistVolume,
} from "@/lib/clientStorage";

export type SfxName =
  // A. свои действия
  | "mic-on"
  | "mic-off"
  | "deafen-on"
  | "deafen-off"
  | "screen-start"
  | "screen-stop"
  | "board-open"
  | "board-close"
  | "board-clear"
  | "leave"
  | "enter"
  // B. события от других / система
  | "peer-join"
  | "peer-leave"
  | "host-granted"
  | "reconnecting"
  | "reconnected"
  // C. тревоги / модерация
  | "force-muted"
  | "kicked"
  | "mic-denied"
  | "mod-error"
  | "lock"
  | "unlock";

// Один тон: частота, момент старта (с) от начала звука, длительность, форма волны
// (по умолчанию sine — самая мягкая), относительная громкость (0..1) и плавный
// «съезд» частоты к glideTo (для свиста-стирания).
type Tone = {
  freq: number;
  at?: number;
  dur?: number;
  type?: OscillatorType;
  gain?: number;
  glideTo?: number;
};

// Вход/выход в комнату звучат одинаково для всех: и когда заходишь сам, и когда
// заходит/уходит другой участник (единый «голос комнаты»). Вынесены в общие
// рецепты и переиспользуются для enter/leave и peer-join/peer-leave.
const ENTER_SOUND: Tone[] = [
  { freq: 392, dur: 0.12, gain: 0.2 },
  { freq: 523, dur: 0.1, gain: 0.3 },
  { freq: 659, at: 0.1, dur: 0.1, gain: 0.3 },
  { freq: 784, at: 0.2, dur: 0.24, gain: 0.32 },
];
const LEAVE_SOUND: Tone[] = [
  { freq: 587, dur: 0.14, gain: 0.3 },
  { freq: 392, at: 0.12, dur: 0.26, gain: 0.3 },
];

// Рецепты звуков. У каждого свой «отпечаток» — разный регистр (бас/средние/
// высокие), форма (одиночный тон, глиссандо, арпеджио, повтор, «щелчок-бац»),
// тембр и длительность, чтобы на слух не сливались. Принцип направления
// сохранён: вверх = включение/хорошо, вниз = выключение/плохо.
const RECIPES: Record<SfxName, Tone[]> = {
  // A — свои действия
  // микрофон: вкл — две крисповые ноты вверх; выкл — мягкий съезд вниз (другая форма)
  "mic-on": [
    { freq: 660, dur: 0.09, gain: 0.3 },
    { freq: 880, at: 0.075, dur: 0.12, gain: 0.3 },
  ],
  "mic-off": [{ freq: 620, dur: 0.18, gain: 0.3, glideTo: 360 }],
  // заглушить всё: низкий «глухой» тон с суб-октавой; вернуть — низкий подъём вверх
  "deafen-on": [
    { freq: 300, dur: 0.22, gain: 0.32, type: "triangle" },
    { freq: 150, dur: 0.22, gain: 0.16 },
  ],
  "deafen-off": [{ freq: 300, dur: 0.2, gain: 0.3, type: "triangle", glideTo: 500 }],
  // экран: яркое высокое арпеджио вверх (+тихая «искра» сверху) / вниз
  "screen-start": [
    { freq: 784, dur: 0.08, gain: 0.24 },
    { freq: 988, at: 0.07, dur: 0.08, gain: 0.24 },
    { freq: 1319, at: 0.14, dur: 0.16, gain: 0.26 },
    { freq: 2637, at: 0.14, dur: 0.16, gain: 0.06 },
  ],
  "screen-stop": [
    { freq: 1319, dur: 0.08, gain: 0.24 },
    { freq: 988, at: 0.07, dur: 0.08, gain: 0.24 },
    { freq: 784, at: 0.14, dur: 0.16, gain: 0.26 },
  ],
  // доска: короткий «вжух» вверх/вниз (глиссандо, мягкий triangle)
  "board-open": [{ freq: 420, dur: 0.16, gain: 0.26, type: "triangle", glideTo: 640 }],
  "board-close": [{ freq: 640, dur: 0.16, gain: 0.26, type: "triangle", glideTo: 420 }],
  // очистка: долгий съезд-свист сверху вниз — ни на что не похож
  "board-clear": [{ freq: 880, dur: 0.28, gain: 0.22, type: "triangle", glideTo: 240 }],
  // вход/выход — общие рецепты (см. ENTER_SOUND / LEAVE_SOUND выше)
  "enter": ENTER_SOUND,
  "leave": LEAVE_SOUND,
  // B — другие / система
  // чужой вход/выход звучат так же, как свой — единый «голос комнаты»
  "peer-join": ENTER_SOUND,
  "peer-leave": LEAVE_SOUND,
  // права хоста: торжественная фанфара — 4 ноты вверх + октава-«искра» (самый яркий)
  "host-granted": [
    { freq: 523, dur: 0.1, gain: 0.28 },
    { freq: 659, at: 0.09, dur: 0.1, gain: 0.28 },
    { freq: 784, at: 0.18, dur: 0.1, gain: 0.3 },
    { freq: 1047, at: 0.28, dur: 0.3, gain: 0.32 },
    { freq: 2093, at: 0.28, dur: 0.3, gain: 0.08 },
  ],
  // связь рвётся: тревожный ПОВТОР одной ноты (уникальная форма — пульс)
  "reconnecting": [
    { freq: 440, dur: 0.1, gain: 0.28 },
    { freq: 440, at: 0.16, dur: 0.1, gain: 0.28 },
  ],
  // связь вернулась: разрешающий скачок вверх (квинта)
  "reconnected": [
    { freq: 523, dur: 0.1, gain: 0.3 },
    { freq: 784, at: 0.1, dur: 0.18, gain: 0.3 },
  ],
  // C — тревоги / модерация
  // заглушил хост: настойчивый «жужжащий» спуск (triangle), средний→низкий
  "force-muted": [
    { freq: 587, dur: 0.12, gain: 0.32, type: "triangle" },
    { freq: 349, at: 0.11, dur: 0.22, gain: 0.32, type: "triangle" },
  ],
  // кикнули: мрачный глубокий спуск в бас (самый длинный, «грустный»)
  "kicked": [
    { freq: 523, dur: 0.12, gain: 0.3 },
    { freq: 392, at: 0.13, dur: 0.13, gain: 0.3 },
    { freq: 262, at: 0.27, dur: 0.32, gain: 0.32 },
  ],
  // нет микрофона: два быстрых НИЗКИХ повтора (короткий «не-а»)
  "mic-denied": [
    { freq: 330, dur: 0.09, gain: 0.3, type: "triangle" },
    { freq: 330, at: 0.13, dur: 0.12, gain: 0.3, type: "triangle" },
  ],
  // ошибка действия: одиночный короткий сухой «дад»
  "mod-error": [{ freq: 294, dur: 0.14, gain: 0.3, type: "triangle" }],
  // замок: механический «ка-чанк» (высокий щелчок → низкий бум); открыть — наоборот
  "lock": [
    { freq: 600, dur: 0.04, gain: 0.26, type: "triangle" },
    { freq: 280, at: 0.05, dur: 0.14, gain: 0.32, type: "triangle" },
  ],
  "unlock": [
    { freq: 280, dur: 0.05, gain: 0.3, type: "triangle" },
    { freq: 600, at: 0.06, dur: 0.1, gain: 0.26, type: "triangle" },
  ],
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null; // общая громкость (volume), обновляется живьём
let enabled = true;
let volume = 0.6;
// При «заглушить всё» (deafen) гасим бытовые звуки, но НЕ тревоги (urgent).
let deafened = false;

function ensureGraph(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    // master → low-pass (тепло, срезаем резкие верхи) → выход
    master = ctx.createGain();
    master.gain.value = volume;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    lp.Q.value = 0.7;
    master.connect(lp).connect(ctx.destination);
  }
  return ctx;
}

function playRecipe(notes: Tone[]): void {
  const c = ctx;
  const out = master;
  if (!c || !out) return;
  const t0 = c.currentTime;
  for (const n of notes) {
    const start = t0 + (n.at ?? 0);
    const dur = n.dur ?? 0.14;
    const peak = Math.max(0.0001, n.gain ?? 0.3);
    const osc = c.createOscillator();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.freq, start);
    if (n.glideTo) osc.frequency.exponentialRampToValueAtTime(n.glideTo, start + dur);
    const g = c.createGain();
    // мягкая огибающая: ~12 мс атака, экспоненциальное затухание (без щелчков)
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }
}

/**
 * Один раз: подтянуть настройки из localStorage и поднять аудио-граф. Зовётся при
 * входе в комнату (после клика пользователя — AudioContext уже можно «разбудить»).
 * Повторные вызовы только освежают настройки.
 */
export function initSfx(): void {
  enabled = getSfxEnabled();
  volume = getSfxVolume();
  ensureGraph();
  if (master) master.gain.value = volume;
}

/**
 * Проиграть звук. urgent:true — тревога: звучит даже при «заглушить всё».
 */
export function playSfx(name: SfxName, opts?: { urgent?: boolean }): void {
  if (!enabled) return;
  if (deafened && !opts?.urgent) return;
  const c = ensureGraph();
  if (!c) return;
  // Автоплей-политика: контекст может стартовать «suspended» — будим его (к этому
  // моменту пользователь уже кликал, так что resume пройдёт).
  if (c.state === "suspended") void c.resume();
  playRecipe(RECIPES[name]);
}

export function setSfxEnabled(value: boolean): void {
  enabled = value;
  persistEnabled(value);
}
export function setSfxVolume(value: number): void {
  volume = value;
  persistVolume(value);
  if (master) master.gain.value = value;
}
export function setSfxDeafened(value: boolean): void {
  deafened = value;
}
