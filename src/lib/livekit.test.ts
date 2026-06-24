import { describe, it, expect } from "vitest";
import {
  generateHostKey,
  generateRoomCode,
  hashPassword,
  verifyPassword,
} from "@/lib/livekit";

describe("hashPassword / verifyPassword", () => {
  it("принимает верный пароль и отвергает неверный", async () => {
    const stored = await hashPassword("s3cret");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword("s3cret", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });
  it("корректно работает с ником/паролем из цифр", async () => {
    const stored = await hashPassword("42");
    expect(await verifyPassword("42", stored)).toBe(true);
    expect(await verifyPassword("43", stored)).toBe(false);
  });
  it("отвергает повреждённый формат хэша (нет двоеточия)", async () => {
    expect(await verifyPassword("x", "deadbeef")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
  it("разные соли дают разные хэши одного пароля", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
});

describe("generateRoomCode / generateHostKey", () => {
  it("код длиной 6 из безопасного алфавита (без 0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
  it("hostKey — длинная hex-строка", () => {
    expect(generateHostKey()).toMatch(/^[0-9a-f]{48}$/);
  });
});
