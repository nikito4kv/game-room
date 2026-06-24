import { describe, it, expect } from "vitest";
import {
  sortPublicRooms,
  toPublicRoomSummaries,
  type PublicRoomCandidate,
} from "@/lib/publicRooms";

function cand(
  name: string,
  numParticipants: number,
  createdAt: number,
  opts: { locked?: boolean } = {},
): PublicRoomCandidate {
  return {
    room: { name, numParticipants, maxParticipants: 6 },
    meta: {
      title: `T-${name}`,
      hostIdentity: `host-${name}`,
      createdAt,
      locked: opts.locked ?? false,
    },
  };
}

describe("sortPublicRooms", () => {
  it("сортирует по участникам убыв., при равенстве — по createdAt убыв.", () => {
    const a = cand("A", 2, 100);
    const b = cand("B", 5, 50);
    const c = cand("C", 2, 200);
    const sorted = sortPublicRooms([a, b, c]);
    expect(sorted.map((x) => x.room.name)).toEqual(["B", "C", "A"]);
  });
  it("не мутирует входной массив", () => {
    const input = [cand("A", 1, 1), cand("B", 2, 2)];
    const copy = [...input];
    sortPublicRooms(input);
    expect(input).toEqual(copy);
  });
});

describe("toPublicRoomSummaries", () => {
  const c = cand("ROOM1", 3, 1000, { locked: true });

  it("auth с паролем → hasPassword true, поля проброшены верно", () => {
    const map = new Map([["ROOM1", { passwordHash: "salt:hash" }]]);
    expect(toPublicRoomSummaries([c], map)).toEqual([
      {
        code: "ROOM1",
        title: "T-ROOM1",
        hostIdentity: "host-ROOM1",
        numParticipants: 3,
        maxParticipants: 6,
        createdAt: 1000,
        locked: true,
        hasPassword: true,
      },
    ]);
  });

  it("auth без пароля → hasPassword false", () => {
    const map = new Map([["ROOM1", { passwordHash: null }]]);
    expect(toPublicRoomSummaries([c], map)[0].hasPassword).toBe(false);
  });

  it("auth === null (нет приватного состояния) → комната исключена", () => {
    const map = new Map<string, { passwordHash: string | null } | null>([["ROOM1", null]]);
    expect(toPublicRoomSummaries([c], map)).toEqual([]);
  });

  it("auth отсутствует (сбой батча) → консервативно hasPassword true", () => {
    const map = new Map<string, { passwordHash: string | null } | null>();
    expect(toPublicRoomSummaries([c], map)[0].hasPassword).toBe(true);
  });
});
