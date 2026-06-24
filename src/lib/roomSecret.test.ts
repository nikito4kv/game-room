import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory заглушка Upstash Redis (методы, которыми пользуется roomSecret).
// auth хранится СТРОКОЙ (set/get) — как у raw-клиента (automaticDeserialization:
// false), который для строк отдаёт значение как есть. Члены сетов — тоже строки.
// Pipeline просто выполняет операции по очереди и возвращает массив результатов.
const { fake } = vi.hoisted(() => {
  const store = new Map<string, string | Set<string>>();
  const api = {
    async set(key: string, value: string) {
      store.set(key, String(value));
      return "OK";
    },
    async get(key: string) {
      const v = store.get(key);
      return typeof v === "string" ? v : null;
    },
    async sadd(key: string, ...members: string[]) {
      const cur = store.get(key);
      const s = cur instanceof Set ? cur : new Set<string>();
      store.set(key, s);
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) {
          s.add(m);
          added++;
        }
      }
      return added;
    },
    async srem(key: string, ...members: string[]) {
      const s = store.get(key);
      if (!(s instanceof Set)) return 0;
      let removed = 0;
      for (const m of members) if (s.delete(m)) removed++;
      if (s.size === 0) store.delete(key);
      return removed;
    },
    async sismember(key: string, member: string) {
      const s = store.get(key);
      return s instanceof Set && s.has(member) ? 1 : 0;
    },
    async smembers(key: string) {
      const s = store.get(key);
      return s instanceof Set ? [...s] : [];
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async expire() {
      return 1;
    },
    pipeline() {
      const ops: Array<() => Promise<unknown>> = [];
      const p: Record<string, unknown> = {};
      for (const m of ["set", "get", "sadd", "srem", "sismember", "smembers", "del", "expire"]) {
        p[m] = (...args: unknown[]) => {
          ops.push(() =>
            (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m](...args),
          );
          return p;
        };
      }
      p.exec = async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      };
      return p;
    },
  };
  return { fake: { api, store } };
});

vi.mock("./redis", () => ({
  getRedisRaw: () => fake.api,
  getRedis: () => fake.api,
}));

import {
  addBan,
  addMember,
  addMute,
  createRoomState,
  deleteRoomState,
  isBanned,
  isMember,
  isMuted,
  loadAuth,
  loadJoinChecks,
  removeBan,
} from "@/lib/roomSecret";

const CODE = "ABC123";

beforeEach(() => {
  fake.store.clear();
});

describe("createRoomState / loadAuth", () => {
  it("сохраняет auth и начального участника", async () => {
    await createRoomState(CODE, { passwordHash: "p:h", hostKeyHash: "k:h", initialMember: "Alice" });
    const auth = await loadAuth(CODE);
    expect(auth).toEqual({ passwordHash: "p:h", hostKeyHash: "k:h" });
    expect(await isMember(CODE, "Alice")).toBe(true);
  });
  it("без пароля passwordHash === null", async () => {
    await createRoomState(CODE, { passwordHash: null, hostKeyHash: "k:h", initialMember: "Bob" });
    expect((await loadAuth(CODE))?.passwordHash).toBeNull();
  });
  it("loadAuth === null, если состояния нет (комната «пропала»)", async () => {
    expect(await loadAuth("NOPE")).toBeNull();
  });
});

describe("идемпотентность и атомарность (баги #1/#5/#12/#16)", () => {
  it("повторный бан идемпотентен, isBanned верно", async () => {
    await createRoomState(CODE, { passwordHash: null, hostKeyHash: "k", initialMember: "Alice" });
    await addBan(CODE, "Troll");
    await addBan(CODE, "Troll");
    expect(await isBanned(CODE, "Troll")).toBe(true);
    await removeBan(CODE, "Troll");
    expect(await isBanned(CODE, "Troll")).toBe(false);
  });

  it("addMember НЕ затирает параллельно выставленные бан/мьют (ключевая гонка)", async () => {
    await createRoomState(CODE, { passwordHash: null, hostKeyHash: "k", initialMember: "Alice" });
    // Имитируем «параллельные» операции на разных коллекциях.
    await addBan(CODE, "Eve");
    await addMute(CODE, "Mallory");
    await addMember(CODE, "Bob"); // раньше перезаписывал весь блоб и мог стереть бан/мьют
    expect(await isBanned(CODE, "Eve")).toBe(true);
    expect(await isMuted(CODE, "Mallory")).toBe(true);
    expect(await isMember(CODE, "Bob")).toBe(true);
  });

  it("ник из цифр не ломается (automaticDeserialization:false)", async () => {
    await createRoomState(CODE, { passwordHash: null, hostKeyHash: "k", initialMember: "42" });
    expect(await isMember(CODE, "42")).toBe(true);
    await addBan(CODE, "42");
    expect(await isBanned(CODE, "42")).toBe(true);
  });
});

describe("loadJoinChecks", () => {
  it("отдаёт auth + все три проверки одним вызовом", async () => {
    await createRoomState(CODE, { passwordHash: "p:h", hostKeyHash: "k", initialMember: "Alice" });
    await addBan(CODE, "Eve");
    await addMute(CODE, "Alice");
    const checks = await loadJoinChecks(CODE, "Alice");
    expect(checks).not.toBeNull();
    expect(checks!.auth.passwordHash).toBe("p:h");
    expect(checks!.member).toBe(true);
    expect(checks!.muted).toBe(true);
    expect(checks!.banned).toBe(false);
    const eve = await loadJoinChecks(CODE, "Eve");
    expect(eve!.banned).toBe(true);
    expect(eve!.member).toBe(false);
  });
  it("null, если состояния нет", async () => {
    expect(await loadJoinChecks("GONE", "x")).toBeNull();
  });
});

describe("deleteRoomState", () => {
  it("удаляет всё состояние комнаты", async () => {
    await createRoomState(CODE, { passwordHash: null, hostKeyHash: "k", initialMember: "Alice" });
    await addBan(CODE, "Eve");
    await deleteRoomState(CODE);
    expect(await loadAuth(CODE)).toBeNull();
    expect(await isBanned(CODE, "Eve")).toBe(false);
    expect(await isMember(CODE, "Alice")).toBe(false);
  });
});
