import { describe, it, expect } from "vitest";
import { formatKeyCode } from "@/lib/keys";

describe("formatKeyCode", () => {
  it("буквы: KeyM → M", () => {
    expect(formatKeyCode("KeyM")).toBe("M");
    expect(formatKeyCode("KeyV")).toBe("V");
  });

  it("цифры верхнего ряда: Digit2 → 2", () => {
    expect(formatKeyCode("Digit2")).toBe("2");
    expect(formatKeyCode("Digit0")).toBe("0");
  });

  it("цифровой блок: Numpad5 → Num 5", () => {
    expect(formatKeyCode("Numpad5")).toBe("Num 5");
  });

  it("функциональные клавиши остаются как есть", () => {
    expect(formatKeyCode("F1")).toBe("F1");
    expect(formatKeyCode("F12")).toBe("F12");
  });

  it("стрелки превращаются в символы", () => {
    expect(formatKeyCode("ArrowUp")).toBe("↑");
    expect(formatKeyCode("ArrowLeft")).toBe("←");
  });

  it("именованные клавиши получают короткую подпись", () => {
    expect(formatKeyCode("Enter")).toBe("Enter");
    expect(formatKeyCode("Escape")).toBe("Esc");
    expect(formatKeyCode("Backquote")).toBe("`");
    expect(formatKeyCode("Space")).toBe("Space");
  });

  it("модификаторы: ShiftLeft → Shift, ControlRight → Ctrl", () => {
    expect(formatKeyCode("ShiftLeft")).toBe("Shift");
    expect(formatKeyCode("ControlRight")).toBe("Ctrl");
    expect(formatKeyCode("AltLeft")).toBe("Alt");
  });

  it("неизвестный код возвращается как есть и не падает", () => {
    expect(formatKeyCode("SomethingWeird")).toBe("SomethingWeird");
    expect(formatKeyCode("")).toBe("");
  });
});
