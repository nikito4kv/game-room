import { describe, it, expect, beforeEach, vi } from "vitest";

// Мокаем все зависимости вебхука: интересует только маршрутизация аналитики
// (recordJoin на входе, captureRoomSession на закрытии непустой комнаты).
const h = vi.hoisted(() => ({
  receive: vi.fn(),
  recordJoin: vi.fn(async () => {}),
  readStats: vi.fn(async () => ({ peak: 0, totalUnique: 0, isPublic: false })),
  cleanupStats: vi.fn(async () => {}),
  captureRoomSession: vi.fn(async () => {}),
  removeParticipant: vi.fn(async () => {}),
}));

vi.mock("@vercel/blob", () => ({
  list: vi.fn(async () => ({ blobs: [], hasMore: false })),
  del: vi.fn(async () => {}),
}));

vi.mock("@/lib/livekit", () => ({
  getWebhookReceiver: () => ({ receive: h.receive }),
  getRoomService: () => ({ removeParticipant: h.removeParticipant }),
  loadPublicMeta: vi.fn(async () => null),
  enforceParticipantMute: vi.fn(async () => {}),
  parseRoomMeta: (raw: string | undefined) => (raw ? JSON.parse(raw) : null),
}));

vi.mock("@/lib/roomSecret", () => ({
  deleteRoomState: vi.fn(async () => {}),
  loadJoinChecks: vi.fn(async () => null),
  touchTtl: vi.fn(async () => {}),
}));

vi.mock("@/lib/analytics/roomStats", () => ({
  recordJoin: (...args: unknown[]) => h.recordJoin(...args),
  readStats: (...args: unknown[]) => h.readStats(...args),
  cleanupStats: (...args: unknown[]) => h.cleanupStats(...args),
}));

vi.mock("@/lib/analytics/posthogServer", () => ({
  captureRoomSession: (...args: unknown[]) => h.captureRoomSession(...args),
}));

import { POST } from "./route";

function post(event: unknown): Promise<Response> {
  h.receive.mockResolvedValueOnce(event);
  return POST(new Request("http://test/api/livekit-webhook", { method: "POST", body: "{}" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("вебхук: аналитика", () => {
  it("participant_joined → recordJoin с numParticipants и isPublic из payload", async () => {
    const res = await post({
      event: "participant_joined",
      room: {
        name: "ABC123",
        numParticipants: 3,
        metadata: JSON.stringify({ title: "t", hostIdentity: "h", createdAt: 1, isPublic: true }),
      },
      participant: { identity: "Alice" },
    });
    expect(res.status).toBe(200);
    expect(h.recordJoin).toHaveBeenCalledWith("ABC123", "Alice", 3, true);
  });

  it("room_finished с участниками → captureRoomSession + cleanup ПОСЛЕ отправки", async () => {
    h.readStats.mockResolvedValueOnce({ peak: 2, totalUnique: 2, isPublic: true });
    const res = await post({
      event: "room_finished",
      createdAt: 1000n,
      room: {
        name: "ABC123",
        creationTime: 940n,
        metadata: JSON.stringify({ title: "t", hostIdentity: "h", createdAt: 1, isPublic: true }),
      },
    });
    expect(res.status).toBe(200);
    expect(h.captureRoomSession).toHaveBeenCalledWith({
      code: "ABC123",
      peak: 2,
      totalUnique: 2,
      durationSec: 60,
      isPublic: true,
    });
    expect(h.cleanupStats).toHaveBeenCalledWith("ABC123");
  });

  it("isPublic берётся из сохранённой статистики, если в payload нет metadata", async () => {
    h.readStats.mockResolvedValueOnce({ peak: 1, totalUnique: 1, isPublic: true });
    await post({
      event: "room_finished",
      createdAt: 1000n,
      room: { name: "ABC123", creationTime: 990n, metadata: "" },
    });
    expect(h.captureRoomSession).toHaveBeenCalledWith(
      expect.objectContaining({ isPublic: true }),
    );
  });

  it("durationSec = 0, если creationTime невалиден (0)", async () => {
    h.readStats.mockResolvedValueOnce({ peak: 1, totalUnique: 1, isPublic: false });
    await post({
      event: "room_finished",
      createdAt: 1700000000n,
      room: { name: "ABC123", creationTime: 0n, metadata: "" },
    });
    expect(h.captureRoomSession).toHaveBeenCalledWith(
      expect.objectContaining({ durationSec: 0 }),
    );
  });

  it("сбой отправки → ключи НЕ стираем (не теряем данные)", async () => {
    h.readStats.mockResolvedValueOnce({ peak: 2, totalUnique: 2, isPublic: false });
    h.captureRoomSession.mockRejectedValueOnce(new Error("network"));
    const res = await post({
      event: "room_finished",
      createdAt: 1000n,
      room: { name: "ABC123", creationTime: 940n, metadata: "" },
    });
    expect(res.status).toBe(200);
    expect(h.cleanupStats).not.toHaveBeenCalled();
  });

  it("room_finished без участников → событие НЕ шлём, но ключи чистим", async () => {
    h.readStats.mockResolvedValueOnce({ peak: 0, totalUnique: 0, isPublic: false });
    await post({
      event: "room_finished",
      createdAt: 1000n,
      room: { name: "EMPTY1", creationTime: 990n, metadata: "" },
    });
    expect(h.captureRoomSession).not.toHaveBeenCalled();
    expect(h.cleanupStats).toHaveBeenCalledWith("EMPTY1");
  });
});
