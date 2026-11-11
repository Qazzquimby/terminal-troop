import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { contentEvent } from "./content-event.js";
import type { PlayerEvent, RoomEvent } from "./content-event.js";
import { defineItem, registerContent } from "./content.js";
import type { WorldContent } from "./content.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";

const session = () =>
  createSession("me", "ME", "EVENTS", "dev", testSfx(), testSimConfig);

/** A number that travels as a string. */
const Spelt = z.codec(z.string(), z.number(), {
  decode: Number,
  encode: String,
});

/** A flare: lit by anyone for everyone. */
const flare = contentEvent({
  schema: z.object({ brightness: Spelt.refine((n) => n >= 0) }),
  to: "all",
  receive: () => undefined,
});

/** A nudge the host gives one player. */
const nudge = contentEvent({
  schema: z.object({ by: z.number() }),
  to: "player",
  from: "host",
  receive: () => undefined,
});

const entry: WorldContent = {
  name: "signals",
  events: { flare, nudge },
  register: () => undefined,
  populate: () => undefined,
};

describe("content events", () => {
  test("an event for one player is sent to a target; any other is not", () => {
    expectTypeOf(flare).toEqualTypeOf<RoomEvent<{ brightness: number }>>();
    expectTypeOf(nudge).toEqualTypeOf<PlayerEvent<{ by: number }>>();
    expectTypeOf<Parameters<typeof flare.send>>().toEqualTypeOf<
      [Session, { brightness: number }]
    >();
    expectTypeOf<Parameters<typeof nudge.send>>().toEqualTypeOf<
      [Session, string, { by: number }]
    >();
  });

  test("a send queues the payload encoded, under its entry's name and its key", () => {
    const game = session();
    registerContent(game, [entry]);
    flare.send(game, { brightness: 3 });
    nudge.send(game, "them", { by: 2 });
    expect(game.outbox).toEqual([
      {
        content: "signals",
        event: "flare",
        route: "all",
        to: null,
        payload: { brightness: "3" },
      },
      {
        content: "signals",
        event: "nudge",
        route: "player",
        to: "them",
        payload: { by: 2 },
      },
    ]);
  });

  test("an event unregistered, or a payload its schema rejects, throws on send", () => {
    const game = session();
    expect(() => {
      flare.send(game, { brightness: 1 });
    }).toThrow();
    registerContent(game, [entry]);
    expect(() => {
      flare.send(game, { brightness: -1 });
    }).toThrow();
    expect(game.outbox).toEqual([]);
  });

  test("an item's own events travel under its name", () => {
    const honk = contentEvent({
      schema: z.object({ pitch: z.number() }),
      to: "all",
      receive: () => undefined,
    });
    const horn = defineItem("horn", () => ({
      name: "Horn",
      maxStack: 1,
      emoji: "📯",
      cooldown: 1,
      events: { honk },
      apply: () => undefined,
      show: (_game, at) => ({ center: at, hit: false }),
      draw: () => undefined,
    }));
    const game = session();
    registerContent(game, [horn.create({ horn: null })]);
    honk.send(game, { pitch: 2 });
    expect(game.outbox).toEqual([
      {
        content: "horn",
        event: "honk",
        route: "all",
        to: null,
        payload: { pitch: 2 },
      },
    ]);
  });

  test("every session has the engine's own events, and content may not take their names", () => {
    const game = session();
    expect(
      [...game.events].map(([name, events]) => [name, [...events.keys()]]),
    ).toEqual([
      ["held", ["use"]],
      ["health", ["damage"]],
    ]);
    expect(() => {
      registerContent(game, [{ ...entry, name: "health" }]);
    }).toThrow("Content name reserved by the engine: health");
  });

  test("an event registered twice throws", () => {
    const game = session();
    expect(() => {
      registerContent(game, [entry, { ...entry, name: "again" }]);
    }).toThrow("Event already registered: again.flare");
  });
});
