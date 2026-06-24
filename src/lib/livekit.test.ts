import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccessToken } from "livekit-server-sdk";
import {
  generateHostKey,
  generateRoomCode,
  hashPassword,
  parseRoomMeta,
  verifyPassword,
  verifyTokenIdentity,
  verifyHostCredentials,
  type RoomPublicMeta,
} from "@/lib/livekit";
import type { RoomAuth } from "@/lib/roomSecret";

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

describe("parseRoomMeta", () => {
  const base = { title: "Игра", isPublic: true, hostIdentity: "Аня", createdAt: 123 };

  it("разбирает валидные metadata", () => {
    expect(parseRoomMeta(JSON.stringify(base))).toEqual({
      title: "Игра",
      isPublic: true,
      hostIdentity: "Аня",
      createdAt: 123,
      locked: false,
    });
  });
  it("требует boolean isPublic; значение сохраняется (фильтрацию делает вызывающий)", () => {
    expect(parseRoomMeta(JSON.stringify({ ...base, isPublic: false }))?.isPublic).toBe(false);
    expect(parseRoomMeta(JSON.stringify(base))?.isPublic).toBe(true);
    // не-boolean isPublic → форма не подтверждена
    expect(parseRoomMeta(JSON.stringify({ ...base, isPublic: "yes" }))).toBeNull();
    expect(parseRoomMeta(JSON.stringify({ ...base, isPublic: undefined }))).toBeNull();
  });
  it("locked приводится строго к boolean true", () => {
    expect(parseRoomMeta(JSON.stringify({ ...base, locked: true }))?.locked).toBe(true);
    expect(parseRoomMeta(JSON.stringify({ ...base, locked: "yes" }))?.locked).toBe(false);
  });
  it("undefined/пусто/битый JSON/не-объект → null", () => {
    expect(parseRoomMeta(undefined)).toBeNull();
    expect(parseRoomMeta("")).toBeNull();
    expect(parseRoomMeta("{не json")).toBeNull();
    expect(parseRoomMeta("null")).toBeNull();
    expect(parseRoomMeta("42")).toBeNull();
  });
  it("неверно типизированные поля → null", () => {
    expect(parseRoomMeta(JSON.stringify({ ...base, title: 1 }))).toBeNull();
    expect(parseRoomMeta(JSON.stringify({ ...base, title: "" }))).toBeNull();
    expect(parseRoomMeta(JSON.stringify({ ...base, hostIdentity: 5 }))).toBeNull();
    expect(parseRoomMeta(JSON.stringify({ ...base, createdAt: "x" }))).toBeNull();
  });
});

// Проверка токена и авторизации хоста (баг: хост терял права через 30 мин, когда
// его join-токен истекал, хотя он оставался в живой комнате). allowExpired должен
// игнорировать срок, не теряя проверки подписи/комнаты/личности.
describe("verifyTokenIdentity / verifyHostCredentials", () => {
  const API_KEY = "devkey";
  // HS256 требует ключ ≥ 256 бит — берём заведомо длинный секрет.
  const API_SECRET = "test-secret-test-secret-test-secret-1234";
  const WRONG_SECRET = "another-secret-another-secret-another-99";
  const CODE = "ROOM01";

  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeAll(() => {
    // getTokenVerifier() — ленивый синглтон, env должна стоять до первого verify.
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = API_KEY;
    process.env.LIVEKIT_API_SECRET = API_SECRET;
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  // ttl < 0 → exp в прошлом (SDK приводит число к строке "<n>s", jose понимает знак).
  async function mintToken(opts: {
    identity: string;
    room: string;
    ttl: number | string;
    secret?: string;
  }): Promise<string> {
    const at = new AccessToken(API_KEY, opts.secret ?? API_SECRET, {
      identity: opts.identity,
      ttl: opts.ttl,
    });
    at.addGrant({ roomJoin: true, room: opts.room });
    return at.toJwt();
  }

  it("строгий режим отвергает просроченный токен", async () => {
    const token = await mintToken({ identity: "Alice", room: CODE, ttl: -60 });
    expect(await verifyTokenIdentity(token, CODE)).toBeNull();
  });

  it("allowExpired принимает просроченный токен и возвращает ник", async () => {
    const token = await mintToken({ identity: "Alice", room: CODE, ttl: -60 });
    expect(await verifyTokenIdentity(token, CODE, { allowExpired: true })).toBe("Alice");
  });

  it("валидный токен проходит и строго, и в allowExpired", async () => {
    const token = await mintToken({ identity: "Alice", room: CODE, ttl: "1h" });
    expect(await verifyTokenIdentity(token, CODE)).toBe("Alice");
    expect(await verifyTokenIdentity(token, CODE, { allowExpired: true })).toBe("Alice");
  });

  it("чужая комната отвергается даже с allowExpired (игнор только exp)", async () => {
    const token = await mintToken({ identity: "Alice", room: "OTHER1", ttl: -60 });
    expect(await verifyTokenIdentity(token, CODE, { allowExpired: true })).toBeNull();
  });

  it("чужая подпись отвергается даже с allowExpired", async () => {
    const token = await mintToken({
      identity: "Alice",
      room: CODE,
      ttl: -60,
      secret: WRONG_SECRET,
    });
    expect(await verifyTokenIdentity(token, CODE, { allowExpired: true })).toBeNull();
  });

  const meta = (hostIdentity: string): RoomPublicMeta => ({
    title: "T",
    isPublic: false,
    hostIdentity,
    createdAt: 0,
  });
  // hostKey не передаём → byHostKey всегда false; проверяем именно путь токена.
  const auth: RoomAuth = { passwordHash: null, hostKeyHash: "k" };

  it("verifyHostCredentials: просроченный токен хоста + allowExpiredToken → isCurrentHost", async () => {
    const token = await mintToken({ identity: "Alice", room: CODE, ttl: -60 });
    const res = await verifyHostCredentials(meta("Alice"), auth, {
      callerToken: token,
      code: CODE,
      allowExpiredToken: true,
    });
    expect(res.isCurrentHost).toBe(true);
  });

  it("verifyHostCredentials: без allowExpiredToken просроченный токен → не хост", async () => {
    const token = await mintToken({ identity: "Alice", room: CODE, ttl: -60 });
    const res = await verifyHostCredentials(meta("Alice"), auth, {
      callerToken: token,
      code: CODE,
    });
    expect(res.isCurrentHost).toBe(false);
  });

  it("verifyHostCredentials: чужой ник (после передачи прав) → не хост даже с allowExpiredToken", async () => {
    const token = await mintToken({ identity: "Bob", room: CODE, ttl: -60 });
    const res = await verifyHostCredentials(meta("Alice"), auth, {
      callerToken: token,
      code: CODE,
      allowExpiredToken: true,
    });
    expect(res.callerIdentity).toBe("Bob");
    expect(res.isCurrentHost).toBe(false);
  });
});
