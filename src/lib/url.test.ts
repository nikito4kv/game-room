import { describe, it, expect } from "vitest";
import { extractRoomCode, normalizePath, scrubRoomCodes } from "@/lib/url";

describe("normalizePath", () => {
  it("вырезает код комнаты из голого пути", () => {
    expect(normalizePath("/room/ABC123")).toBe("/room/[code]");
  });

  it("вырезает код комнаты, сохраняя хвост пути", () => {
    expect(normalizePath("/room/ABC123/settings")).toBe("/room/[code]/settings");
  });

  it("вырезает код комнаты из полного URL (только pathname)", () => {
    expect(normalizePath("https://example.com/room/XYZ789?x=1")).toBe(
      "/room/[code]",
    );
  });

  it("не трогает путь без комнаты", () => {
    expect(normalizePath("/rooms")).toBe("/rooms");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("scrubRoomCodes", () => {
  it("вырезает код из произвольного текста, сохраняя контекст", () => {
    expect(scrubRoomCodes("failed to join /room/ABC123 now")).toBe(
      "failed to join /room/[code] now",
    );
  });

  it("сохраняет схему и хост в полном URL, режет только код", () => {
    expect(scrubRoomCodes("https://app.example.com/room/ABC123?invite=x")).toBe(
      "https://app.example.com/room/[code]?invite=x",
    );
  });

  it("вырезает все вхождения", () => {
    expect(scrubRoomCodes("/room/AAA and /room/BBB")).toBe(
      "/room/[code] and /room/[code]",
    );
  });

  it("не трогает текст без кода комнаты", () => {
    expect(scrubRoomCodes("ничего интересного")).toBe("ничего интересного");
  });
});

describe("extractRoomCode", () => {
  it("достаёт код из пути", () => {
    expect(extractRoomCode("/room/ABC123")).toBe("ABC123");
  });

  it("достаёт код из полного URL и заголовка Referer", () => {
    expect(extractRoomCode("https://app/room/XYZ789/chat")).toBe("XYZ789");
    expect(extractRoomCode("https://app.example.com/room/QWE?x=1")).toBe("QWE");
  });

  it("возвращает null, если кода нет", () => {
    expect(extractRoomCode("/rooms")).toBeNull();
    expect(extractRoomCode("https://app/")).toBeNull();
  });

  it("идемпотентность: на уже затёртом /room/[code] возвращает null", () => {
    expect(extractRoomCode("/room/[code]")).toBeNull();
    expect(extractRoomCode(scrubRoomCodes("/room/ABC123"))).toBeNull();
  });
});
