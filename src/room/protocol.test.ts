import { describe, expect, expectTypeOf, test } from "vitest";
import { NetEvent } from "../net/index.js";
import { roomMessages } from "./protocol.js";
import type { Message, MessageInput, RoomMessages } from "./protocol.js";

const messages = roomMessages(3);

describe("the message table", () => {
  test("covers every event", () => {
    expectTypeOf<keyof RoomMessages>().toEqualTypeOf<NetEvent>();
    expect(Object.keys(messages).sort()).toEqual(
      Object.values(NetEvent).sort(),
    );
  });

  test("types each payload by its event", () => {
    expectTypeOf<Message<"bye">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Message<"hello">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<MessageInput<"state">>().toEqualTypeOf<{
      id: string;
      name: string;
      x: number;
      y: number;
      aim: number;
    }>();
    expectTypeOf<Message<"beat">>().toEqualTypeOf<{
      id: string;
      hidden: boolean;
      host: { id: string; term: number; solo: boolean } | null;
    }>();
    expectTypeOf<Message<"entities">>().toEqualTypeOf<{
      host: string;
      entities: {
        id: string;
        kind: number;
        x: number;
        y: number;
        data: unknown;
      }[];
    }>();
    expectTypeOf<Message<"signal">>().toBeUnknown();
  });

  test("a STATE's name is cut to nameMax", () => {
    const parsed = messages.state.safeParse({
      id: "x",
      name: "ABCDE",
      x: 1,
      y: 2,
      aim: 0,
    });
    expect(parsed.data?.name).toBe("ABC");
  });

  test.each([
    [NetEvent.HELLO, { id: "" }],
    [NetEvent.BYE, { id: 7 }],
    [NetEvent.STATE, { id: "x", name: "X", x: Number.NaN, y: 0, aim: 0 }],
    [NetEvent.STATE, { id: "x", name: "X", x: 0, y: 0 }],
    [NetEvent.HEARTBEAT, { id: "x", hidden: false }],
    [
      NetEvent.HEARTBEAT,
      { id: "x", hidden: false, host: { id: "x", term: -1, solo: false } },
    ],
    [
      NetEvent.HEARTBEAT,
      { id: "x", hidden: false, host: { id: "x", term: 0 } },
    ],
    [NetEvent.ENTITIES, { host: "x" }],
    [
      NetEvent.ENTITIES,
      { host: "x", entities: [{ id: "x:1", kind: 0, x: 0, y: 0, data: {} }] },
    ],
    [
      NetEvent.ENTITIES,
      {
        host: "x",
        entities: [{ id: "x:1", kind: 1, x: Infinity, y: 0, data: {} }],
      },
    ],
    [
      NetEvent.ENTITIES,
      {
        host: "x",
        entities: Array.from({ length: 257 }, (_, i) => ({
          id: `x:${String(i)}`,
          kind: 1,
          x: 0,
          y: 0,
          data: {},
        })),
      },
    ],
  ])("a bad %s payload does not parse", (event, payload) => {
    expect(messages[event].safeParse(payload).success).toBe(false);
  });
});
