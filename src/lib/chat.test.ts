import { describe, it, expect } from "vitest";
import {
  MAX_CHAT_LEN,
  decodeChat,
  encodeChat,
  hueForIdentity,
  sanitizeChatText,
} from "@/lib/chat";

describe("encodeChat / decodeChat", () => {
  it("round-trip: текст переживает кодирование и декодирование", () => {
    const msg = decodeChat(encodeChat("привет, отряд"));
    expect(msg).toEqual({ t: "msg", text: "привет, отряд" });
  });

  it("возвращает null на битый JSON", () => {
    expect(decodeChat(new TextEncoder().encode("{не json"))).toBeNull();
  });

  it("возвращает null, если payload — не объект", () => {
    expect(decodeChat(new TextEncoder().encode('"строка"'))).toBeNull();
    expect(decodeChat(new TextEncoder().encode("42"))).toBeNull();
    expect(decodeChat(new TextEncoder().encode("null"))).toBeNull();
  });

  it("возвращает null при отсутствующем/чужом поле t", () => {
    expect(decodeChat(new TextEncoder().encode('{"text":"hi"}'))).toBeNull();
    expect(decodeChat(new TextEncoder().encode('{"t":"board","text":"hi"}'))).toBeNull();
  });
});

describe("sanitizeChatText", () => {
  it("обрезает пробелы по краям", () => {
    expect(sanitizeChatText("  привет  ")).toBe("привет");
  });

  it("возвращает null для пустого, из одних пробелов и не-строки", () => {
    expect(sanitizeChatText("")).toBeNull();
    expect(sanitizeChatText("   \n  ")).toBeNull();
    expect(sanitizeChatText(123)).toBeNull();
    expect(sanitizeChatText(null)).toBeNull();
    expect(sanitizeChatText(undefined)).toBeNull();
  });

  it("обрезает по MAX_CHAT_LEN", () => {
    const long = "a".repeat(MAX_CHAT_LEN + 50);
    expect(sanitizeChatText(long)).toHaveLength(MAX_CHAT_LEN);
  });

  it("схлопывает 3+ перевода строки в два", () => {
    expect(sanitizeChatText("a\n\n\n\n\nb")).toBe("a\n\nb");
    // один-два перевода оставляем как есть
    expect(sanitizeChatText("a\n\nb")).toBe("a\n\nb");
    expect(sanitizeChatText("a\nb")).toBe("a\nb");
  });
});

describe("hueForIdentity", () => {
  it("детерминирован: один вход → один выход", () => {
    expect(hueForIdentity("Guest2")).toBe(hueForIdentity("Guest2"));
  });

  it("всегда в диапазоне 0..359", () => {
    for (const id of ["", "a", "Guest2", "очень-длинный-идентификатор-участника-1234567890"]) {
      const h = hueForIdentity(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("пустая строка → 0", () => {
    expect(hueForIdentity("")).toBe(0);
  });
});
