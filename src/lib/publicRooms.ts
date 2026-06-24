// Форма одной публичной комнаты для витрины (/rooms) и GET /api/rooms.
// Чистый тип без серверных импортов: livekit.ts серверный (node:crypto, секреты),
// поэтому общий контракт между эндпоинтом и клиентом держим здесь. Никаких
// секретов — только то, что безопасно показать в публичном списке.
export type PublicRoomSummary = {
  /** Код комнаты (он же room.name в LiveKit). */
  code: string;
  title: string;
  /** Ник текущего хоста. */
  hostIdentity: string;
  numParticipants: number;
  maxParticipants: number;
  /** Время создания (ms). Берётся из metadata, не из bigint room.creationTime. */
  createdAt: number;
  /** Комната закрыта для новых участников — в витрине не кликабельна. */
  locked: boolean;
  /** Есть ли пароль (узнаём из Redis-auth, сам пароль/хэш не раскрываем). */
  hasPassword: boolean;
};

/**
 * Кандидат в витрину: живая комната LiveKit + её разобранные публичные metadata.
 * Минимальная форма (без типов серверного SDK) — модуль остаётся чистым и
 * тестируемым без Redis/LiveKit.
 */
export type PublicRoomCandidate = {
  room: { name: string; numParticipants: number; maxParticipants: number };
  meta: { title: string; hostIdentity: string; createdAt: number; locked: boolean };
};

/** Сортировка витрины: больше участников → новее. Чистая (без мутации входа). */
export function sortPublicRooms(candidates: PublicRoomCandidate[]): PublicRoomCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.room.numParticipants - a.room.numParticipants ||
      b.meta.createdAt - a.meta.createdAt,
  );
}

/**
 * Собирает summary из УЖЕ отобранной верхушки и батча auth (его читаем только по
 * этим кодам — см. /api/rooms). Семантика auth по коду:
 *  • null      — приватного состояния нет: /api/token такую комнату отвергнет, пропускаем;
 *  • undefined — батч auth упал: состояние неизвестно, консервативно hasPassword:true;
 *  • объект    — hasPassword по passwordHash.
 */
export function toPublicRoomSummaries(
  candidates: PublicRoomCandidate[],
  authByCode: Map<string, { passwordHash: string | null } | null>,
): PublicRoomSummary[] {
  return candidates.flatMap(({ room, meta }) => {
    const auth = authByCode.get(room.name);
    if (auth === null) return [];
    return [
      {
        code: room.name,
        title: meta.title,
        hostIdentity: meta.hostIdentity,
        numParticipants: room.numParticipants,
        maxParticipants: room.maxParticipants,
        createdAt: meta.createdAt,
        locked: meta.locked,
        hasPassword: auth ? auth.passwordHash != null : true,
      },
    ];
  });
}
