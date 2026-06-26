// Протокол текстового чата комнаты. Живёт поверх того же data-канала LiveKit, что
// и доска, но под своим топиком — каналы не пересекаются. Это клиентский модуль
// (без серверных секретов), типы держим в одном месте, чтобы стороны не разъехались.
//
// Автор сообщения НЕ передаётся в payload: его берут из отправителя пакета
// (`from` в data-сообщении LiveKit), поэтому подделать ник нельзя. По сети летит
// только текст.

/** Топик data-канала, под которым живут все сообщения чата. */
export const CHAT_TOPIC = "chat";

/** Максимальная длина одного сообщения (символов). Длиннее — обрезаем. */
export const MAX_CHAT_LEN = 500;
/** Максимум сообщений в логе. Старые вытесняются (чат эфемерный, истории нет). */
export const MAX_CHAT_LOG = 200;

/** Сообщение в сети: только текст, автор — из отправителя пакета. */
export type ChatWire = { t: "msg"; text: string };

/** Сообщение в UI-логе (локальная модель, по сети не летит). */
export type ChatMessage = {
  /** Локальный уникальный ключ для React. */
  id: string;
  /** identity отправителя (для цвета позывного и группировки). */
  identity: string;
  /** Отображаемое имя (ник или identity). */
  name: string;
  text: string;
  /** Время получения/отправки (мс). */
  ts: number;
  /** true — наше собственное сообщение. */
  mine: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Кодирует текст сообщения в байты для publishData. */
export function encodeChat(text: string): Uint8Array {
  const msg: ChatWire = { t: "msg", text };
  return encoder.encode(JSON.stringify(msg));
}

/** Декодирует входящие байты. null — если payload не разобрался (битый пакет). */
export function decodeChat(payload: Uint8Array): ChatWire | null {
  try {
    const msg = JSON.parse(decoder.decode(payload)) as unknown;
    if (!msg || typeof msg !== "object") return null;
    if ((msg as { t?: unknown }).t !== "msg") return null;
    return msg as ChatWire;
  } catch {
    return null;
  }
}

/**
 * Приводит произвольный вход к корректному тексту сообщения или возвращает null.
 * Сообщения приходят от других участников (у всех есть canPublishData), поэтому
 * доверять форме нельзя: режем по краям, отбрасываем пустое/не-строку, схлопываем
 * длинные серии переводов строк и ограничиваем длину.
 */
export function sanitizeChatText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Схлопываем 3+ перевода строки в два — не даём раздуть строку чата по высоте.
  const text = raw.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  return text.length > MAX_CHAT_LEN ? text.slice(0, MAX_CHAT_LEN) : text;
}

/**
 * Детерминированный оттенок (0..360) из identity для цвета «позывного». У всех
 * участников один и тот же ник → один и тот же цвет, поэтому собеседники
 * различаются взглядом. Насыщенность/светлоту фиксируем в CSS под тёмную тему.
 *
 * Своя rolling-mod-360 математика (не общий fnv1a32 из @/lib/hash): область
 * значений — оттенок 0..359, а контракт hueForIdentity("") === 0 зафиксирован
 * тестом; перевод на общий хэш сменил бы цвета всем участникам.
 */
export function hueForIdentity(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return h;
}
