import { describe, it, expect } from "vitest";
import {
  clamp01,
  decodeBoardMessage,
  encodeBoardMessage,
  isHexColor,
  MAX_CLOCK,
  MAX_FIGURES,
  MAX_ID_LEN,
  MAX_LABEL_LEN,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  quantizeCoord,
  safeColor,
  safeLabel,
  sanitizeBgUrl,
  sanitizeClock,
  sanitizeFigure,
  sanitizeFigures,
  sanitizePoints,
  sanitizeStroke,
  sanitizeStrokes,
} from "@/lib/board";

describe("isHexColor", () => {
  it("принимает ровно 3/4/6/8 цифр", () => {
    for (const c of ["#abc", "#abcd", "#a1b2c3", "#a1b2c3d4", "#FFF"]) {
      expect(isHexColor(c)).toBe(true);
    }
  });
  it("отвергает невалидные длины 5 и 7 (баг #18)", () => {
    expect(isHexColor("#12345")).toBe(false);
    expect(isHexColor("#1234567")).toBe(false);
  });
  it("отвергает мусор", () => {
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#gggggg")).toBe(false);
    expect(isHexColor(123)).toBe(false);
    expect(isHexColor(null)).toBe(false);
  });
});

describe("safeColor", () => {
  it("возвращает валидный цвет или fallback", () => {
    expect(safeColor("#a1b2c3", "#000")).toBe("#a1b2c3");
    expect(safeColor("#12345", "#000000")).toBe("#000000");
    expect(safeColor(undefined, "#111")).toBe("#111");
  });
});

describe("sanitizeClock (баг #19 — заморозка доски)", () => {
  it("принимает корректные неотрицательные целые", () => {
    expect(sanitizeClock(0)).toBe(0);
    expect(sanitizeClock(5)).toBe(5);
    expect(sanitizeClock(MAX_CLOCK)).toBe(MAX_CLOCK);
  });
  it("отвергает гигантские/бесконечные/дробные/отрицательные значения", () => {
    expect(sanitizeClock(1e308)).toBeNull(); // Number.isFinite(1e308) === true, но > MAX_CLOCK
    expect(sanitizeClock(MAX_CLOCK + 1)).toBeNull();
    expect(sanitizeClock(Infinity)).toBeNull();
    expect(sanitizeClock(-1)).toBeNull();
    expect(sanitizeClock(1.5)).toBeNull();
    expect(sanitizeClock("5")).toBeNull();
    expect(sanitizeClock(NaN)).toBeNull();
  });
});

describe("sanitizePoints (баг #20 — кэп точек)", () => {
  it("фильтрует нечисловые/неполные точки и зажимает в 0..1", () => {
    const pts = sanitizePoints([
      [0.5, 0.5],
      [2, -1], // зажмётся в [1, 0]
      ["x", 0], // отброшено
      [0.1], // отброшено (нет y)
    ]);
    expect(pts).toEqual([
      [0.5, 0.5],
      [1, 0],
    ]);
  });
  it("ограничивает число точек сверху", () => {
    const huge = Array.from({ length: MAX_POINTS_PER_STROKE + 100 }, () => [0.5, 0.5]);
    expect(sanitizePoints(huge).length).toBe(MAX_POINTS_PER_STROKE);
  });
});

describe("sanitizeStroke (баг #21 — длина id)", () => {
  it("отвергает пустой/нестроковый/слишком длинный id", () => {
    expect(sanitizeStroke({ id: "", points: [[0, 0]] })).toBeNull();
    expect(sanitizeStroke({ id: 123, points: [[0, 0]] })).toBeNull();
    expect(sanitizeStroke({ id: "a".repeat(MAX_ID_LEN + 1), points: [[0, 0]] })).toBeNull();
  });
  it("принимает корректный штрих и подставляет дефолты", () => {
    const s = sanitizeStroke({ id: "ok", points: [[0.2, 0.3]], color: "#12345", size: 5 });
    expect(s).not.toBeNull();
    expect(s!.id).toBe("ok");
    expect(s!.color).toBe("#000000"); // невалидный цвет → дефолт
    expect(s!.mode).toBe("draw");
    expect(s!.size).toBe(1); // 5 зажато в 0..1
  });
  it("отвергает штрих без валидных точек", () => {
    expect(sanitizeStroke({ id: "x", points: [] })).toBeNull();
    expect(sanitizeStroke({ id: "x", points: "nope" })).toBeNull();
  });
});

describe("sanitizeStrokes (кэп числа штрихов)", () => {
  it("ограничивает число штрихов сверху", () => {
    const many = Array.from({ length: MAX_STROKES + 50 }, (_, i) => ({
      id: `s${i}`,
      points: [[0.1, 0.1]],
    }));
    expect(sanitizeStrokes(many).length).toBe(MAX_STROKES);
  });
});

describe("sanitizeBgUrl", () => {
  it("разрешает только http(s) и data:image", () => {
    expect(sanitizeBgUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(sanitizeBgUrl("http://a/b")).toBe("http://a/b");
    expect(sanitizeBgUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  it("блокирует опасные схемы", () => {
    expect(sanitizeBgUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeBgUrl("data:text/html,<script>")).toBeNull();
    expect(sanitizeBgUrl(42)).toBeNull();
  });
});

describe("clamp01 / quantizeCoord", () => {
  it("clamp01 зажимает в 0..1", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });
  it("quantizeCoord округляет до 4 знаков", () => {
    expect(quantizeCoord(0.123456789)).toBe(0.1235);
  });
});

describe("encode/decode round-trip", () => {
  it("кодирует и декодирует сообщение доски", () => {
    const msg = { t: "clear", epoch: 3 } as const;
    expect(decodeBoardMessage(encodeBoardMessage(msg))).toEqual(msg);
  });
  it("возвращает null на битом payload", () => {
    expect(decodeBoardMessage(new TextEncoder().encode("{не json"))).toBeNull();
  });
});

describe("safeLabel", () => {
  it("обрезает по длине и чистит управляющие символы", () => {
    expect(safeLabel("  Player  ")).toBe("Player");
    expect(safeLabel("a\n\tb")).toBe("ab");
    expect(safeLabel("x".repeat(40))).toHaveLength(MAX_LABEL_LEN);
    expect(safeLabel(123)).toBe("");
    expect(safeLabel(null)).toBe("");
  });
});

describe("sanitizeFigure", () => {
  it("принимает корректную фигурку и зажимает координаты", () => {
    expect(sanitizeFigure({ id: "p1", team: "ct", label: "1", x: 1.5, y: -0.2 })).toEqual({
      id: "p1", team: "ct", label: "1", x: 1, y: 0,
    });
  });
  it("отвергает кривую команду, id и нечисловые координаты", () => {
    expect(sanitizeFigure({ id: "p1", team: "x", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "", team: "ct", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "a".repeat(200), team: "ct", label: "", x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeFigure({ id: "p1", team: "ct", label: "", x: "0.5", y: 0.5 })).toBeNull();
    expect(sanitizeFigure(null)).toBeNull();
  });
});

describe("sanitizeFigures", () => {
  it("фильтрует мусор и режет по MAX_FIGURES", () => {
    const ok = { id: "p", team: "t", label: "", x: 0.1, y: 0.1 };
    expect(sanitizeFigures([ok, "junk", { id: "q", team: "z", x: 0, y: 0 }])).toHaveLength(1);
    const many = Array.from({ length: MAX_FIGURES + 10 }, (_, i) => ({ ...ok, id: `p${i}` }));
    expect(sanitizeFigures(many)).toHaveLength(MAX_FIGURES);
  });
});
