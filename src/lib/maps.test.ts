import { describe, it, expect } from "vitest";
import { CS2_MAPS } from "@/lib/maps";
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
