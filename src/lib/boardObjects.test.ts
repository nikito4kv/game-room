import { describe, it, expect } from "vitest";
import {
  CS2_OBJECTS,
  objDef,
  objClass,
  genObjectId,
  applyGeom,
} from "@/lib/boardObjects";
import { MAX_OBJ_RADIUS, MIN_OBJ_RADIUS, type GameObject } from "@/lib/board";

describe("CS2_OBJECTS catalog", () => {
  it("zone-типы имеют defaultRadius, icon-типы — нет", () => {
    for (const d of CS2_OBJECTS) {
      if (d.cls === "zone") expect(typeof d.defaultRadius).toBe("number");
      else expect(d.defaultRadius).toBeUndefined();
    }
  });
  it("objDef/objClass находят по kind", () => {
    expect(objClass("smoke")).toBe("zone");
    expect(objClass("flash")).toBe("icon");
    expect(objDef("he").color).toMatch(/^#/);
  });
});

describe("genObjectId", () => {
  it("склеивает identity и seq", () => {
    expect(genObjectId("p1.ab", 4)).toBe("p1.ab-obj-4");
  });
});

describe("applyGeom", () => {
  const o: GameObject = { id: "o1", kind: "smoke", x: 0.5, y: 0.5, radius: 0.07 };
  it("патчит координаты и зажимает", () => {
    expect(applyGeom(o, { x: 2, y: -1 })).toMatchObject({ x: 1, y: 0 });
  });
  it("строит from из частичного патча", () => {
    expect(applyGeom(o, { fromX: 0.2, fromY: 0.3 }).from).toEqual({ x: 0.2, y: 0.3 });
  });
  it("зажимает radius в пределах", () => {
    expect(applyGeom(o, { radius: 99 }).radius).toBe(MAX_OBJ_RADIUS);
    expect(applyGeom(o, { radius: 0 }).radius).toBe(MIN_OBJ_RADIUS);
  });
  it("не трогает поля, которых нет в патче", () => {
    const r = applyGeom(o, { x: 0.6 });
    expect(r.radius).toBe(0.07);
    expect(r.y).toBe(0.5);
  });
});
