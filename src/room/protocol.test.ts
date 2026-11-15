import { omit } from "lodash-es";
import { describe, expect, expectTypeOf, test } from "vitest";
import { NetEvent } from "../net/index.js";
import { Health } from "../sim/index.js";
import { roomMessages } from "./protocol.js";
import type { Message, RoomMessages, WireMessage } from "./protocol.js";

const messages = roomMessages(3);

/** A STATE that parses. */
const state = {
  id: "x",
  name: "X",
  aim: 0,
  content: {},
};

/** A player as a host's snapshot carries it. */
const player = {
  id: "x",
  name: "X",
  step: 12,
  x: 6383.650081222386,
  y: 2070.0499,
  vx: 1.5,
  vy: -2.25,
  stamina: { value: 33.333333333333336, exhausted: false, rested: 0.6 },
  crouched: false,
  dash: { vx: 100, vy: 0, seconds: 0.1, to: { x: 6400, y: 2070 } },
  ride: {
    vehicle: "7",
    driving: true,
    heading: 0.123456789,
    speed: 287.654321,
    turn: -1,
  },
  steer: { move: { x: 0.6, y: -0.8 }, sprint: true, held: 0 },
  content: { "core/movement": { mode: "sprint", moving: true } },
};

describe("rounding", () => {
  test("a STATE sends its aim to a hundredth, and where it starts as it is", () => {
    const schema = messages[NetEvent.STATE];
    const at = { x: 6383.650081222386, y: 2070.0499 };
    const wire = schema.encode({ ...state, aim: -2.827866375587991, at });
    expect(wire).toMatchObject({ aim: -2.83, at });
    const heard = schema.parse(JSON.parse(JSON.stringify(wire)));
    expect(heard.aim).toBeCloseTo(-2.827866375587991, 2);
  });

  test("a snapshot sends each player as the host runs it, unrounded, so its own client can tell it ran the same", () => {
    const snapshot = {
      host: "h",
      origin: "o",
      full: false,
      time: 1,
      entities: [],
      changed: [],
      removed: [],
      players: [player],
    };
    const schema = messages[NetEvent.ENTITIES];
    const wire: unknown = JSON.parse(JSON.stringify(schema.encode(snapshot)));
    expect(schema.parse(wire)).toEqual(snapshot);
  });

  test("a snapshot sends each entity's position to a tenth of a pixel", () => {
    const wire = messages[NetEvent.ENTITIES].encode({
      host: "h",
      origin: "o",
      full: false,
      time: 12.345,
      entities: [{ id: "1", kind: 1, x: 10.04, y: 19.96, health: 1, data: {} }],
      changed: [{ id: "2", x: 5.06 }],
      removed: [],
      players: [],
    });
    expect(wire.entities[0]).toMatchObject({ x: 10, y: 20 });
    expect(wire.changed[0]).toEqual({ id: "2", x: 5.1 });
    expect(wire.time).toBe(12.35);
  });
});

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
      origin: "o",
      full: false,
      time: 3,
      entities: [
        { id: "1", kind: 1, x: 10, y: 20, health: 40, data: {} },
        { id: "2", kind: 2, x: 30, y: 40, health: Infinity, data: {} },
      ],
      changed: [{ id: "3", health: Infinity, patch: { a: 1 } }],
      removed: [],
      players: [],
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
      aim: number;
      content: Record<string, unknown>;
      at?: { x: number; y: number } | undefined;
    }>();
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
      origin: string;
      full: boolean;
      time: number;
      entities: {
        id: string;
        kind: number;
        x: number;
        y: number;
        health: number;
        data: unknown;
      }[];
      changed: {
        id: string;
        x?: number | undefined;
        y?: number | undefined;
        health?: number | undefined;
        data?: unknown;
        patch?: Record<string, unknown> | undefined;
      }[];
      removed: string[];
      players: Message<"entities">["players"];
    }>();
    expectTypeOf<Message<"world">>().toEqualTypeOf<{
      host: string;
      term: number;
      entries: Record<string, unknown>;
    }>();
    expectTypeOf<Message<"content">>().toEqualTypeOf<{
      from: string;
      to: string | null;
      content: string;
      event: string;
      payload: unknown;
    }>();
    expectTypeOf<Message<"signal">>().toBeUnknown();
  });

  test("a STATE's name is cut to nameMax", () => {
    const parsed = messages.state.safeParse({ ...state, name: "ABCDE" });
    expect(parsed.data?.name).toBe("ABC");
  });

  test.each([
    {},
    { "core/items": "shovel" },
    { "core/items": null, "item/lamp": { on: true, fuel: "Infinity" } },
    { "an-entry-this-build-lacks": [1, 2] },
  ])("a STATE's content %o parses as is, left to each entry", (content) => {
    expect(
      messages.state.safeParse({ ...state, content }).data?.content,
    ).toEqual(content);
  });

  test.each([
    { from: "a", to: null, content: "core/items", event: "use", payload: 1 },
    {
      from: "a",
      to: "b",
      content: "core/health",
      event: "damage",
      payload: {},
    },
    {
      from: "a",
      to: null,
      content: "item/lamp",
      event: "toggle",
      payload: null,
    },
  ])("a CONTENT's payload %o parses as is, left to its event", (message) => {
    expect(messages.content.safeParse(message).data).toEqual(message);
  });

  const content = {
    from: "a",
    to: null,
    content: "core/items",
    event: "use",
    payload: {},
  };

  test.each([
    [NetEvent.HELLO, { id: "" }],
    [NetEvent.BYE, { id: 7 }],
    [NetEvent.STATE, { ...state, at: { x: Number.NaN, y: 0 } }],
    [NetEvent.STATE, { ...state, at: { x: 1 } }],
    [NetEvent.STATE, omit(state, "aim")],
    [NetEvent.STATE, omit(state, "content")],
    [NetEvent.STATE, { ...state, content: null }],
    [NetEvent.STATE, { ...state, content: "shovel" }],
    [NetEvent.STATE, { ...state, content: ["shovel"] }],
    [NetEvent.CONTENT, { ...content, from: "" }],
    [NetEvent.CONTENT, omit(content, "to")],
    [NetEvent.CONTENT, { ...content, to: "" }],
    [NetEvent.CONTENT, { ...content, content: "" }],
    [NetEvent.CONTENT, { ...content, event: "x".repeat(65) }],
    [NetEvent.CONTENT, { ...content, event: 7 }],
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
        origin: "x",
        full: true,
        time: 0,
        entities: [],
        changed: [],
        removed: [],
        players: [{ ...player, x: Number.NaN }],
      },
    ],
    [
      NetEvent.ENTITIES,
      {
        host: "x",
        origin: "x",
        full: true,
        time: 0,
        entities: [],
        changed: [],
        removed: [],
        players: [{ ...player, steer: { ...player.steer, held: 64 } }],
      },
    ],
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
