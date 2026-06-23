// Клиентское хранилище (без секретов сервера).
// Единое место для ключей localStorage/sessionStorage, чтобы они не расходились
// между лендингом и страницей комнаты.

const NICK_KEY = "gr.nickname";
const pwKey = (code: string) => `gr.pw.${code}`;
const hostKeyKey = (code: string) => `gr.host.${code}`;
const BOARD_COLOR_KEY = "gr.board.color";
const BOARD_SIZE_KEY = "gr.board.size";

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
