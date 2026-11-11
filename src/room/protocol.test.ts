import { omit } from "lodash-es";
import { describe, expect, expectTypeOf, test } from "vitest";
import { NetEvent } from "../net/index.js";
import { Health, roomMessages } from "./protocol.js";
import type { Message, RoomMessages, WireMessage } from "./protocol.js";

const messages = roomMessages(3);

/** A STATE that parses. */
const state = {
  id: "x",
  name: "X",
  x: 1,
  y: 2,
  aim: 0,
  health: 100,
  content: {},
};

describe("health", () => {
  test.each([0, 12.5, Infinity])(
    "%d survives encoding and decoding",
    (health) => {
      expect(Health.decode(Health.encode(health))).toBe(health);
    },
  );

  test("Infinity travels as a string, and other health as itself", () => {
    expect(Health.encode(Infinity)).toBe("Infinity");
    expect(Health.encode(40)).toBe(40);
    expect(Health.parse("Infinity")).toBe(Infinity);
  });

  test.each([Number.NaN, -1, -Infinity, Infinity, "infinity", "40", null])(
    "%s is rejected on the wire",
    (wire) => {
      expect(Health.safeParse(wire).success).toBe(false);
    },
  );

  test.each([Number.NaN, -1, -Infinity])("%d cannot be sent", (health) => {
    expect(() => Health.encode(health)).toThrow();
  });

  test("an encoded snapshot with unbreakable health survives JSON", () => {
    const snapshot: Message<"entities"> = {
      host: "h",
      entities: [
        { id: "h:1", kind: 1, x: 10, y: 20, health: 40, data: {} },
        { id: "h:2", kind: 2, x: 30, y: 40, health: Infinity, data: {} },
      ],
    };
    const schema = messages[NetEvent.ENTITIES];
    const wire: unknown = JSON.parse(JSON.stringify(schema.encode(snapshot)));
    expect(schema.parse(wire)).toEqual(snapshot);
  });
});

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
    expectTypeOf<WireMessage<"state">>().toEqualTypeOf<{
      id: string;
      name: string;
      x: number;
      y: number;
      aim: number;
      health: number | "Infinity";
      content: Record<string, unknown>;
    }>();
    expectTypeOf<Message<"state">["health"]>().toEqualTypeOf<number>();
    expectTypeOf<Message<"state">["content"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
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
        health: number;
        data: unknown;
      }[];
    }>();
    expectTypeOf<Message<"use">>().toEqualTypeOf<{
      by: string;
      item: string;
      x: number;
      y: number;
      aim: number;
    }>();
    expectTypeOf<Message<"damage">>().toEqualTypeOf<{
      host: string;
      target: string;
      amount: number;
    }>();
    expectTypeOf<Message<"signal">>().toBeUnknown();
  });

  test("a STATE's name is cut to nameMax", () => {
    const parsed = messages.state.safeParse({ ...state, name: "ABCDE" });
    expect(parsed.data?.name).toBe("ABC");
  });

  test.each([
    {},
    { inventory: "shovel" },
    { inventory: null, lamp: { on: true, fuel: "Infinity" } },
    { "an-entry-this-build-lacks": [1, 2] },
  ])("a STATE's content %o parses as is, left to each entry", (content) => {
    expect(
      messages.state.safeParse({ ...state, content }).data?.content,
    ).toEqual(content);
  });

  test.each([
    [NetEvent.HELLO, { id: "" }],
    [NetEvent.BYE, { id: 7 }],
    [NetEvent.STATE, { ...state, x: Number.NaN }],
    [NetEvent.STATE, omit(state, "aim")],
    [NetEvent.STATE, omit(state, "health")],
    [NetEvent.STATE, { ...state, health: -1 }],
    [NetEvent.STATE, omit(state, "content")],
    [NetEvent.STATE, { ...state, content: null }],
    [NetEvent.STATE, { ...state, content: "shovel" }],
    [NetEvent.STATE, { ...state, content: ["shovel"] }],
    [NetEvent.USE, { by: "x", item: "", x: 0, y: 0, aim: 0 }],
    [NetEvent.USE, { by: "x", item: "shovel", x: 0, y: Infinity, aim: 0 }],
    [NetEvent.DAMAGE, { host: "x", target: "y", amount: 0 }],
    [NetEvent.DAMAGE, { host: "x", target: "y", amount: Number.NaN }],
    [NetEvent.DAMAGE, { host: "x", target: "", amount: 5 }],
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
      {
        host: "x",
        entities: [{ id: "x:1", kind: 0, x: 0, y: 0, health: 1, data: {} }],
      },
    ],
    [
      NetEvent.ENTITIES,
      { host: "x", entities: [{ id: "x:1", kind: 1, x: 0, y: 0, data: {} }] },
    ],

    [
      NetEvent.ENTITIES,
      {
        host: "x",
        entities: [
          { id: "x:1", kind: 1, x: Infinity, y: 0, health: 1, data: {} },
        ],
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
