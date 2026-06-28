import { describe, it, expect } from "vitest";
import { CS2_MAPS, mapAspect } from "@/lib/maps";
import { BUILTIN_MAP_RE, sanitizeBgUrl } from "@/lib/board";

describe("CS2_MAPS", () => {
  it("непустой и с уникальными id", () => {
    expect(CS2_MAPS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(CS2_MAPS.map((m) => m.id)).size).toBe(CS2_MAPS.length);
  });
  it("каждый src проходит вайтлист фона и имеет положительный aspect", () => {
    for (const m of CS2_MAPS) {
      expect(BUILTIN_MAP_RE.test(m.src)).toBe(true);
      expect(sanitizeBgUrl(m.src)).toBe(m.src);
      expect(m.aspect).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0);
    }
  });
});

describe("mapAspect", () => {
  it("возвращает aspect встроенной карты по src", () => {
    expect(mapAspect("/maps/cs2/mirage.png")).toBe(1);
  });
  it("null для неизвестного src и для null", () => {
    expect(mapAspect("https://example.com/x.png")).toBeNull();
    expect(mapAspect(null)).toBeNull();
  });
});
