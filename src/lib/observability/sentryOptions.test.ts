import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubEvent } from "./sentryOptions";
import { hashRoomCode } from "@/lib/hash";

describe("scrubEvent — скрабинг кода комнаты", () => {
  it("режет код в request.url, сохраняя хост и query", () => {
    const event = {
      request: { url: "https://app.example.com/room/ABC123?x=1" },
    } as ErrorEvent;
    expect(scrubEvent(event).request?.url).toBe(
      "https://app.example.com/room/[code]?x=1",
    );
  });

  it("режет код в заголовке Referer (утечка через headers)", () => {
    const event = {
      request: {
        url: "https://app/api/token",
        headers: { Referer: "https://app/room/SECRET", "X-Other": "keep" },
      },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.request?.headers?.Referer).toBe("https://app/room/[code]");
    expect(out.request?.headers?.["X-Other"]).toBe("keep");
  });

  it("режет код в сообщении и в тексте исключения", () => {
    const event = {
      message: "failed at /room/ABC123",
      exception: { values: [{ value: "join /room/ABC123 failed" }] },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.message).toBe("failed at /room/[code]");
    expect(out.exception?.values?.[0].value).toBe("join /room/[code] failed");
  });

  it("режет код во всех строковых полях хлебных крошек", () => {
    const event = {
      breadcrumbs: [
        { message: "navigated to /room/AAA", data: { url: "/room/AAA/chat" } },
        { data: { from: "/room/AAA", to: "/room/BBB", note: "/room/CCC" } },
        { data: { foo: "bar" } },
      ],
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.breadcrumbs?.[0].message).toBe("navigated to /room/[code]");
    expect(out.breadcrumbs?.[0].data?.url).toBe("/room/[code]/chat");
    expect(out.breadcrumbs?.[1].data?.from).toBe("/room/[code]");
    expect(out.breadcrumbs?.[1].data?.to).toBe("/room/[code]");
    // даже нестандартный ключ чистится (не только url/from/to)
    expect(out.breadcrumbs?.[1].data?.note).toBe("/room/[code]");
    expect(out.breadcrumbs?.[2].data?.foo).toBe("bar");
  });

  it("не падает на пустом событии", () => {
    expect(() => scrubEvent({} as ErrorEvent)).not.toThrow();
  });
});

describe("scrubEvent — тег room для корреляции", () => {
  it("выводит тег из URL события (серверная ошибка на /room/[code])", () => {
    const event = {
      request: { url: "https://app/room/ABC123" },
    } as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.tags?.room).toBe(hashRoomCode("ABC123"));
  });

  it("выводит тег из Referer, когда код не в URL (ошибка /api/token)", () => {
    const event = {
      request: {
        url: "https://app/api/token",
        headers: { referer: "https://app/room/ABC123" },
      },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.tags?.room).toBe(hashRoomCode("ABC123"));
  });

  it("не перетирает тег, уже выставленный клиентом", () => {
    const event = {
      tags: { room: "client-set" },
      request: { url: "https://app/room/ABC123" },
    } as unknown as ErrorEvent;
    expect(scrubEvent(event).tags?.room).toBe("client-set");
  });

  it("не ставит тег, если кода комнаты нигде нет", () => {
    const event = { request: { url: "https://app/rooms" } } as ErrorEvent;
    expect(scrubEvent(event).tags?.room).toBeUndefined();
  });
});
