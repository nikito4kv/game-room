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
const AUDIO_MASTER_VOLUME_KEY = "gr.audio.masterVolume";
const AUDIO_VOLUMES_KEY = "gr.audio.volumes";
const AUDIO_MUTES_KEY = "gr.audio.mutes";

/** Ник пользователя — переживает перезагрузку (localStorage). */
export function getNickname(): string | null {
  return localStorage.getItem(NICK_KEY);
}
export function setNickname(nick: string): void {
  localStorage.setItem(NICK_KEY, nick);
}

/**
 * Пароль комнаты кладём в sessionStorage только на время перехода в комнату,
 * чтобы не светить его в URL. Живёт до момента входа, потом стирается.
 */
export function stashPassword(code: string, password: string): void {
  if (password) sessionStorage.setItem(pwKey(code), password);
}
export function takePassword(code: string): string | undefined {
  return sessionStorage.getItem(pwKey(code)) ?? undefined;
}
export function clearPassword(code: string): void {
  sessionStorage.removeItem(pwKey(code));
}

/**
 * Секрет хоста: выдаётся создателю комнаты и подтверждает его права.
 * Лежит в localStorage, чтобы хост мог вернуться после перезагрузки.
 */
export function stashHostKey(code: string, key: string): void {
  localStorage.setItem(hostKeyKey(code), key);
}
export function getHostKey(code: string): string | undefined {
  return localStorage.getItem(hostKeyKey(code)) ?? undefined;
}

/**
 * Настройки кисти доски (цвет и толщина в «логических» px). Переживают
 * перезагрузку, чтобы не выбирать заново каждый вход. Толщину храним числом.
 */
export function getBoardColor(): string | null {
  return localStorage.getItem(BOARD_COLOR_KEY);
}
export function setBoardColor(color: string): void {
  localStorage.setItem(BOARD_COLOR_KEY, color);
}
export function getBoardSize(): number | null {
  const raw = localStorage.getItem(BOARD_SIZE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}
export function setBoardSize(size: number): void {
  localStorage.setItem(BOARD_SIZE_KEY, String(size));
}

/**
 * Аудио-настройки (Этап 5a). Всё «для себя» и переживает перезагрузку.
 * Геттеры терпимы к мусору/недоступному localStorage — возвращают дефолт.
 */

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // приватный режим / переполнение — настройка просто не сохранится
  }
}

/** Выбранный микрофон (deviceId). Пусто — системный по умолчанию. */
export function getInputDevice(): string | null {
  try {
    return localStorage.getItem(AUDIO_INPUT_DEVICE_KEY);
  } catch {
    return null;
  }
}
export function setInputDevice(id: string): void {
  writeString(AUDIO_INPUT_DEVICE_KEY, id);
}

/** Выбранное устройство вывода (deviceId). Пусто — системное по умолчанию. */
export function getOutputDevice(): string | null {
  try {
    return localStorage.getItem(AUDIO_OUTPUT_DEVICE_KEY);
  } catch {
    return null;
  }
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

/** Общая громкость приёма: 1 = 100%, диапазон 0..1. */
export function getMasterVolume(): number {
  return readNumber(AUDIO_MASTER_VOLUME_KEY, 1);
}
export function setMasterVolume(value: number): void {
  writeString(AUDIO_MASTER_VOLUME_KEY, String(value));
}

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
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
