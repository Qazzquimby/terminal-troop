import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyWorldState,
  createSession,
  registerContent,
  worldData,
  worldState,
} from "./index.js";

function session() {
  return createSession("me", "ME", "WORLD", "dev", testSfx(), testSimConfig);
}

/** A count that may be endless, sent as the string "Infinity" when it is. */
const Count = z.codec(
  z.union([z.number().int().min(0), z.literal("Infinity")]),
  z.union([z.number().int().min(0), z.literal(Infinity)]),
  {
    decode: (wire) => (wire === "Infinity" ? Infinity : wire),
    encode: (count) => (count === Infinity ? "Infinity" : count),
  },
);

/** A session with a world-wide count registered under `entity/well`. */
function withWell() {
  const game = session();
  const water = worldData({ schema: Count, initial: 3 });
  registerContent(game, [
    {
      name: "entity/well",
      world: water,
      register: () => undefined,
      populate: () => undefined,
    },
  ]);
  return { game, water };
}

test("a value reads as its initial one until the host sets it", () => {
  const { game, water } = withWell();
  expectTypeOf(water.get(game)).toEqualTypeOf<number>();
  expect(water.get(game)).toBe(3);
  expect(water.set(game, 5)).toBe(true);
  expect(water.get(game)).toBe(5);
});

test("only the host sets a value; another client keeps what the host sent", () => {
  const { game, water } = withWell();
  game.hosting = false;
  expect(water.set(game, 9)).toBe(false);
  expect(water.get(game)).toBe(3);
});

test("the host sends each entry's value encoded, and another client decodes it", () => {
  const host = withWell();
  host.water.set(host.game, Infinity);
  const wire: unknown = JSON.parse(JSON.stringify(worldState(host.game)));
  expect(wire).toEqual({ "entity/well": "Infinity" });

  const guest = withWell();
  guest.game.hosting = false;
  applyWorldState(guest.game, { "entity/well": "Infinity" });
  expect(guest.water.get(guest.game)).toBe(Infinity);
});

test("a value its schema rejects, or of an entry this client lacks, is dropped; the rest apply", () => {
  const { game, water } = withWell();
  applyWorldState(game, { "entity/well": -1, "entity/other": 4 });
  expect(water.get(game)).toBe(3);
  applyWorldState(game, { "entity/other": 4, "entity/well": 7 });
  expect(water.get(game)).toBe(7);
});

test("an entry name registered twice throws", () => {
  const game = session();
  const water = worldData({ schema: Count, initial: 0 });
  const entry = {
    world: water,
    register: () => undefined,
    populate: () => undefined,
  };
  expect(() => {
    registerContent(game, [
      { ...entry, name: "entity/well" },
      { ...entry, name: "entity/well" },
    ]);
  }).toThrow();
});
