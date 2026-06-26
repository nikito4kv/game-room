import { describe, it, expect } from "vitest";
import { fnv1a32, hashRoomCode } from "@/lib/hash";

describe("fnv1a32", () => {
  it("детерминирован", () => {
    expect(fnv1a32("ABC123")).toBe(fnv1a32("ABC123"));
  });

  it("различается для разных строк", () => {
    expect(fnv1a32("ABC123")).not.toBe(fnv1a32("XYZ789"));
  });

  it("возвращает беззнаковое 32-битное число", () => {
    const h = fnv1a32("любая строка");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("hashRoomCode", () => {
  it("стабилен для одного и того же кода", () => {
    expect(hashRoomCode("ABC123")).toBe(hashRoomCode("ABC123"));
  });

  it("не равен исходному коду (не раскрывает его)", () => {
    expect(hashRoomCode("ABC123")).not.toBe("ABC123");
  });

  it("различается для разных кодов", () => {
    expect(hashRoomCode("ABC123")).not.toBe(hashRoomCode("XYZ789"));
  });

  it("использует ~64-битное пространство (две части по base36)", () => {
    // Склейка двух 32-битных хэшей → строка заметной длины, коллизии маловероятны.
    expect(hashRoomCode("A")).toMatch(/^[0-9a-z]+$/);
    // Простой smoke на отсутствие коллизий на небольшой выборке.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(hashRoomCode(`ROOM${i}`));
    expect(seen.size).toBe(2000);
  });
});
