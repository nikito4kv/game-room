import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory заглушка Upstash raw-клиента. Поддерживает eval (recordJoin исполняет
// атомарный Lua) и pipeline get/scard (readStats) + del (cleanupStats). eval
// воспроизводит ровно те операции, что делает RECORD_JOIN_LUA, над тем же store.
const { fake } = vi.hoisted(() => {
  const store = new Map<string, string | Set<string>>();
  const api = {
    async get(key: string) {
      const v = store.get(key);
      return typeof v === "string" ? v : null;
    },
    async scard(key: string) {
      const s = store.get(key);
      return s instanceof Set ? s.size : 0;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    // eval(script, keys, args) — эмулируем RECORD_JOIN_LUA:
    // keys = [peak, uniq, pub]; args = [n, ttl, identity, isPublic].
    async eval(_script: string, keys: string[], args: string[]) {
      const [kPeak, kUniq, kPub] = keys;
      const [nStr, , identity, isPublic] = args;
      const n = Number(nStr);
      const set = store.get(kUniq);
      const s = set instanceof Set ? set : new Set<string>();
      store.set(kUniq, s);
      s.add(identity);
      const cur = Number(store.get(kPeak)) || 0;
      if (n > cur) store.set(kPeak, String(n));
      store.set(kPub, isPublic);
      return 1;
    },
    pipeline() {
      const ops: Array<() => Promise<unknown>> = [];
      const p: Record<string, unknown> = {};
      for (const m of ["get", "scard", "del"]) {
        p[m] = (...a: unknown[]) => {
          ops.push(() =>
            (api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m](...a),
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

vi.mock("../redis", () => ({
  getRedisRaw: () => fake.api,
  getRedis: () => fake.api,
}));

import { recordJoin, readStats, cleanupStats } from "@/lib/analytics/roomStats";

const CODE = "ABC123";

beforeEach(() => {
  fake.store.clear();
});

describe("recordJoin / readStats / cleanupStats", () => {
  it("пик = максимум numParticipants, не последнее значение", async () => {
    await recordJoin(CODE, "Alice", 1, false);
    await recordJoin(CODE, "Bob", 2, false);
    await recordJoin(CODE, "Alice", 1, false); // numParticipants упал — пик держится
    expect((await readStats(CODE)).peak).toBe(2);
  });

  it("пик не опускается ниже 1, даже если numParticipants=0", async () => {
    await recordJoin(CODE, "Alice", 0, false);
    expect((await readStats(CODE)).peak).toBe(1);
  });

  it("уникальные ники считаются без дублей", async () => {
    await recordJoin(CODE, "Alice", 1, false);
    await recordJoin(CODE, "Bob", 2, false);
    await recordJoin(CODE, "Alice", 2, false);
    expect((await readStats(CODE)).totalUnique).toBe(2);
  });

  it("публичность сохраняется и читается", async () => {
    await recordJoin(CODE, "Alice", 1, true);
    expect((await readStats(CODE)).isPublic).toBe(true);
  });

  it("readStats не стирает данные; cleanupStats стирает", async () => {
    await recordJoin(CODE, "Alice", 3, true);
    expect(await readStats(CODE)).toEqual({ peak: 3, totalUnique: 1, isPublic: true });
    // повторное чтение всё ещё видит данные
    expect((await readStats(CODE)).peak).toBe(3);

    await cleanupStats(CODE);
    expect(await readStats(CODE)).toEqual({ peak: 0, totalUnique: 0, isPublic: false });
  });

  it("по пустой комнате — нули", async () => {
    expect(await readStats("GONE")).toEqual({ peak: 0, totalUnique: 0, isPublic: false });
  });

  it("ник из цифр не ломает подсчёт (raw, без авто-парсинга)", async () => {
    await recordJoin(CODE, "42", 1, false);
    await recordJoin(CODE, "7", 2, false);
    const stats = await readStats(CODE);
    expect(stats.peak).toBe(2);
    expect(stats.totalUnique).toBe(2);
  });
});
