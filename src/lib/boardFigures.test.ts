import { describe, it, expect } from "vitest";
import { nextFigureNumber, genFigureId } from "@/lib/boardFigures";
import type { Figure } from "@/lib/board";

const fig = (team: "ct" | "t", label: string): Figure => ({ id: label, team, label, x: 0, y: 0 });

describe("nextFigureNumber", () => {
  it("на пустой команде даёт 1", () => {
    expect(nextFigureNumber([], "ct")).toBe(1);
  });
  it("заполняет пропуск в нумерации", () => {
    expect(nextFigureNumber([fig("ct", "1"), fig("ct", "3")], "ct")).toBe(2);
  });
  it("игнорирует другую команду и нечисловые подписи", () => {
    expect(nextFigureNumber([fig("t", "1"), fig("ct", "Den")], "ct")).toBe(1);
  });
  it("после пятёрки продолжает 6", () => {
    const five = ["1", "2", "3", "4", "5"].map((l) => fig("t", l));
    expect(nextFigureNumber(five, "t")).toBe(6);
  });
  it("не считает недесятичные подписи (0x5, 1e2, дробные) за номера", () => {
    // ни одна из этих подписей не рисуется как номер (FigureLayer тестит /^\d+$/),
    // поэтому они не должны занимать слоты 5/100/… — следующий номер всё ещё 1.
    expect(nextFigureNumber([fig("ct", "0x5"), fig("ct", "1e2"), fig("ct", "1.5")], "ct")).toBe(1);
  });
});

describe("genFigureId", () => {
  it("склеивает identity и seq", () => {
    expect(genFigureId("abc", 7)).toBe("abc-fig-7");
  });
});
