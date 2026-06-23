// Клиентское хранилище (без секретов сервера).
// Единое место для ключей localStorage/sessionStorage, чтобы они не расходились
// между лендингом и страницей комнаты.

const NICK_KEY = "gr.nickname";
const pwKey = (code: string) => `gr.pw.${code}`;
const hostKeyKey = (code: string) => `gr.host.${code}`;

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
