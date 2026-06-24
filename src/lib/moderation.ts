// Клиентские вызовы модерации (Этап 5). Сами действия выполняет сервер
// (/api/moderate) с секретными ключами LiveKit — здесь только запрос.
import { getHostKey } from "./clientStorage";

export type ModerationAction =
  | "kick"
  | "ban"
  | "unban"
  | "mute"
  | "unmute"
  | "transfer"
  | "lock"
  | "unlock";

/**
 * Просит сервер выполнить модераторское действие. Авторизуемся собственным
 * LiveKit-токеном (callerToken) и, если он есть, секретом хоста (hostKey).
 */
export async function moderate(
  code: string,
  callerToken: string,
  action: ModerationAction,
  target?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/moderate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        action,
        target,
        callerToken,
        hostKey: getHostKey(code),
      }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: (data as { error?: string }).error };
  } catch {
    return { ok: false, error: "Сеть недоступна" };
  }
}
