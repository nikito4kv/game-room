// Клиентское хранилище (без секретов сервера).
// Единое место для ключей localStorage/sessionStorage, чтобы они не расходились
// между лендингом и страницей комнаты.

const NICK_KEY = "gr.nickname";
const pwKey = (code: string) => `gr.pw.${code}`;
const hostKeyKey = (code: string) => `gr.host.${code}`;
const BOARD_COLOR_KEY = "gr.board.color";
const BOARD_SIZE_KEY = "gr.board.size";

const AUDIO_INPUT_DEVICE_KEY = "gr.audio.inputDevice";
const AUDIO_OUTPUT_DEVICE_KEY = "gr.audio.outputDevice";
const AUDIO_INPUT_GAIN_KEY = "gr.audio.inputGain";
const AUDIO_NOISE_SUPPRESSION_KEY = "gr.audio.noiseSuppression";
const AUDIO_MASTER_VOLUME_KEY = "gr.audio.masterVolume";
const AUDIO_VOLUMES_KEY = "gr.audio.volumes";
const AUDIO_MUTES_KEY = "gr.audio.mutes";
const SFX_ENABLED_KEY = "gr.sfx.enabled";
const SFX_VOLUME_KEY = "gr.sfx.volume";

const KEYBINDS_KEY = "gr.keybinds";
const VOICE_MODE_KEY = "gr.voice.mode";
const SHOW_KEYS_KEY = "gr.keys.show";

/**
 * Безопасный доступ к Web Storage. В некоторых браузерах (Safari «блокировать
 * все cookie», Firefox с отключённым dom.storage, жёсткие корп-политики) сам
 * вызов getItem/setItem бросает SecurityError. Эти исключения, прилетая из
 * useEffect без error boundary, роняли бы всё дерево в белый экран — поэтому
 * ВЕСЬ доступ к storage идёт только через эти хелперы, которые гасят сбой.
 */
function safeGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}
function safeSet(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // приватный режим / переполнение / заблокированное хранилище — просто не сохраняем
  }
}
function safeRemove(storage: () => Storage, key: string): void {
  try {
    storage().removeItem(key);
  } catch {
    // хранилище недоступно — нечего и удалять
  }
}

const local = () => localStorage;
const session = () => sessionStorage;

/** Ник пользователя — переживает перезагрузку (localStorage). */
export function getNickname(): string | null {
  return safeGet(local, NICK_KEY);
}
export function setNickname(nick: string): void {
  safeSet(local, NICK_KEY, nick);
}

/**
 * Пароль комнаты кладём в sessionStorage только на время перехода в комнату,
 * чтобы не светить его в URL. Живёт до момента входа, потом стирается.
 */
export function stashPassword(code: string, password: string): void {
  if (password) safeSet(session, pwKey(code), password);
}
export function takePassword(code: string): string | undefined {
  return safeGet(session, pwKey(code)) ?? undefined;
}
export function clearPassword(code: string): void {
  safeRemove(session, pwKey(code));
}

/**
 * Секрет хоста: выдаётся создателю комнаты и подтверждает его права.
 * Лежит в localStorage, чтобы хост мог вернуться после перезагрузки.
 */
export function stashHostKey(code: string, key: string): void {
  safeSet(local, hostKeyKey(code), key);
}
export function getHostKey(code: string): string | undefined {
  return safeGet(local, hostKeyKey(code)) ?? undefined;
}

/**
 * Настройки кисти доски (цвет и толщина в «логических» px). Переживают
 * перезагрузку, чтобы не выбирать заново каждый вход. Толщину храним числом.
 */
export function getBoardColor(): string | null {
  return safeGet(local, BOARD_COLOR_KEY);
}
export function setBoardColor(color: string): void {
  safeSet(local, BOARD_COLOR_KEY, color);
}
export function getBoardSize(): number | null {
  const raw = safeGet(local, BOARD_SIZE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}
export function setBoardSize(size: number): void {
  safeSet(local, BOARD_SIZE_KEY, String(size));
}

/**
 * Аудио-настройки (Этап 5a). Всё «для себя» и переживает перезагрузку.
 * Геттеры терпимы к мусору/недоступному localStorage — возвращают дефолт.
 */

function readNumber(key: string, fallback: number): number {
  const raw = safeGet(local, key);
  const n = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function writeString(key: string, value: string): void {
  safeSet(local, key, value);
}

/** Выбранный микрофон (deviceId). Пусто — системный по умолчанию. */
export function getInputDevice(): string | null {
  return safeGet(local, AUDIO_INPUT_DEVICE_KEY);
}
export function setInputDevice(id: string): void {
  writeString(AUDIO_INPUT_DEVICE_KEY, id);
}

/** Выбранное устройство вывода (deviceId). Пусто — системное по умолчанию. */
export function getOutputDevice(): string | null {
  return safeGet(local, AUDIO_OUTPUT_DEVICE_KEY);
}
export function setOutputDevice(id: string): void {
  writeString(AUDIO_OUTPUT_DEVICE_KEY, id);
}

/** Усиление своего микрофона: 1 = 100% (без эффекта), диапазон 0..2. */
export function getInputGain(): number {
  return readNumber(AUDIO_INPUT_GAIN_KEY, 1);
}
export function setInputGain(value: number): void {
  writeString(AUDIO_INPUT_GAIN_KEY, String(value));
}

/**
 * Шумоподавление микрофона (RNNoise + noise gate). Включено по умолчанию —
 * давит дыхание, клавиатуру и фоновый шум. Источник правды для MicProcessor.
 */
export function getNoiseSuppression(): boolean {
  const raw = safeGet(local, AUDIO_NOISE_SUPPRESSION_KEY);
  return raw === null ? true : raw === "1";
}
export function setNoiseSuppression(value: boolean): void {
  writeString(AUDIO_NOISE_SUPPRESSION_KEY, value ? "1" : "0");
}

/** Общая громкость приёма: 1 = 100%, диапазон 0..1. */
export function getMasterVolume(): number {
  return readNumber(AUDIO_MASTER_VOLUME_KEY, 1);
}
export function setMasterVolume(value: number): void {
  writeString(AUDIO_MASTER_VOLUME_KEY, String(value));
}

/**
 * Звуки интерфейса (клики, вход/выход, тревоги). Вкл по умолчанию; громкость
 * 0..1 (дефолт 0.6 — заметно тише голоса). Источник правды для модуля sfx.ts.
 */
export function getSfxEnabled(): boolean {
  const raw = safeGet(local, SFX_ENABLED_KEY);
  return raw === null ? true : raw === "1";
}
export function setSfxEnabled(value: boolean): void {
  writeString(SFX_ENABLED_KEY, value ? "1" : "0");
}
export function getSfxVolume(): number {
  return readNumber(SFX_VOLUME_KEY, 0.6);
}
export function setSfxVolume(value: number): void {
  writeString(SFX_VOLUME_KEY, String(value));
}

function readMap<T>(key: string): Record<string, T> {
  const raw = safeGet(local, key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  writeString(key, JSON.stringify(map));
}

/** Персональная громкость каждого участника (по нику): 1 = 100%, 0..2. */
export function getParticipantVolumes(): Record<string, number> {
  return readMap<number>(AUDIO_VOLUMES_KEY);
}
/** Сохранить громкость участника. Дефолт (1) удаляем из карты, чтобы не пухла. */
export function setParticipantVolume(identity: string, value: number): void {
  const map = getParticipantVolumes();
  if (value === 1) delete map[identity];
  else map[identity] = value;
  writeMap(AUDIO_VOLUMES_KEY, map);
}

/** Персональный «заглушить для меня» каждого участника (по нику). */
export function getParticipantMutes(): Record<string, boolean> {
  return readMap<boolean>(AUDIO_MUTES_KEY);
}
/** Сохранить мьют участника. Снятый мьют удаляем из карты. */
export function setParticipantMute(identity: string, muted: boolean): void {
  const map = getParticipantMutes();
  if (muted) map[identity] = true;
  else delete map[identity];
  writeMap(AUDIO_MUTES_KEY, map);
}

/**
 * Горячие клавиши и режим голоса. Всё «для себя», переживает перезагрузку.
 */

/** Действия, которые можно повесить на клавишу. */
export type KeyAction = "mic" | "deafen" | "screen" | "board" | "chat" | "ptt";
/** Карта действие → e.code (физическая клавиша, не зависит от раскладки). */
export type Keybinds = Record<KeyAction, string>;

/**
 * Дефолтные привязки. Значения — e.code, чтобы работало на любой раскладке.
 * `ptt` (рация) по умолчанию на V — как привычно по Discord.
 */
export const DEFAULT_KEYBINDS: Keybinds = {
  mic: "KeyM",
  deafen: "KeyD",
  screen: "KeyS",
  board: "Digit2",
  chat: "Enter",
  ptt: "KeyV",
};

/**
 * Привязки клавиш. Сохранённое сливаем ПОВЕРХ дефолтов (новые действия не ломают
 * старые сохранения) и САНИРУЕМ: значение должно быть непустой строкой, а коды не
 * должны повторяться. Иначе мусор/конфликт в localStorage (ручная правка, баг
 * миграции, будущий импорт) тихо «убил» бы действие — обработчик ищет код в карте,
 * а пустая строка или дубль не сматчились бы / перекрыли друг друга.
 */
export function getKeybinds(): Keybinds {
  const raw = readMap<unknown>(KEYBINDS_KEY);
  const actions = Object.keys(DEFAULT_KEYBINDS) as KeyAction[];
  // Стартуем с дефолтов (уникальны) и применяем сохранённый override только если он
  // непустая строка И его код не занят ДРУГИМ действием в текущей карте. Так итог
  // всегда полон и без дублей: ни одно действие не «съест» клавишу другого.
  const result = { ...DEFAULT_KEYBINDS };
  for (const action of actions) {
    const v = raw[action];
    if (typeof v !== "string" || !v) continue; // мусор/пусто — оставляем дефолт
    const clash = actions.some((a) => a !== action && result[a] === v);
    if (clash) continue; // конфликт — отклоняем override, дефолт остаётся
    result[action] = v;
  }
  return result;
}
export function setKeybinds(binds: Keybinds): void {
  writeMap(KEYBINDS_KEY, binds);
}

/** Режим голоса: "toggle" (открытый микрофон) | "ptt" (рация). */
export type VoiceMode = "toggle" | "ptt";
export function getVoiceMode(): VoiceMode {
  return safeGet(local, VOICE_MODE_KEY) === "ptt" ? "ptt" : "toggle";
}
export function setVoiceMode(mode: VoiceMode): void {
  writeString(VOICE_MODE_KEY, mode);
}

/** Показывать ли букву бинда на кнопках дока. Вкл по умолчанию. */
export function getShowKeys(): boolean {
  const raw = safeGet(local, SHOW_KEYS_KEY);
  return raw === null ? true : raw === "1";
}
export function setShowKeys(value: boolean): void {
  writeString(SHOW_KEYS_KEY, value ? "1" : "0");
}
