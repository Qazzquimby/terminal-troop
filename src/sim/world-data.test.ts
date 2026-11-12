import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyWorldEntries,
  createSession,
  registerContent,
  takeWorldEntries,
  worldData,
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

/** A session with a world-wide count and a name registered under `entity/well`. */
function withWell() {
  const game = session();
  const water = worldData({ schema: Count, initial: 3 });
  const keeper = worldData({ schema: z.string(), initial: "nobody" });
  registerContent(game, [
    {
      name: "entity/well",
      world: { water, keeper },
      register: () => undefined,
      populate: () => undefined,
    },
  ]);
  return { game, water, keeper };
}

const hostA = { host: "a", term: 1 };

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

test("a full send carries every entry, one never set at version 0; a delta only those set since", () => {
  const { game, water, keeper } = withWell();
  expect(takeWorldEntries(game, true)).toEqual({
    "core/predictions.handled": [0, {}],
    "entity/well.water": [0, 3],
    "entity/well.keeper": [0, "nobody"],
  });
  expect(takeWorldEntries(game, false)).toBeNull();
  water.set(game, Infinity);
  water.set(game, 4);
  expect(takeWorldEntries(game, false)).toEqual({
    "entity/well.water": [2, 4],
  });
  expect(takeWorldEntries(game, false)).toBeNull();
  keeper.set(game, "nobody");
  water.set(game, 4);
  expect(takeWorldEntries(game, false)).toEqual({
    "entity/well.keeper": [1, "nobody"],
  });
});

test("setting the value held changes nothing", () => {
  const { game, water } = withWell();
  water.set(game, 4);
  takeWorldEntries(game, false);
  water.set(game, 4);
  expect(takeWorldEntries(game, false)).toBeNull();
  expect(takeWorldEntries(game, true)).toMatchObject({
    "entity/well.water": [1, 4],
  });
});

test("each value travels encoded, and another client decodes it", () => {
  const host = withWell();
  host.water.set(host.game, Infinity);
  const wire: unknown = JSON.parse(
    JSON.stringify(takeWorldEntries(host.game, false)),
  );
  expect(wire).toEqual({ "entity/well.water": [1, "Infinity"] });

  const guest = withWell();
  guest.game.hosting = false;
  applyWorldEntries(
    guest.game,
    hostA,
    z.record(z.string(), z.unknown()).parse(wire),
  );
  expect(guest.water.get(guest.game)).toBe(Infinity);
});

test("an entry malformed, its schema rejects, or of a name this client lacks is dropped; the rest apply", () => {
  const { game, water, keeper } = withWell();
  applyWorldEntries(game, hostA, {
    "entity/well.water": [1, -1],
    "entity/well.keeper": [1, "ana"],
    "entity/other.x": [1, 4],
  });
  expect(water.get(game)).toBe(3);
  expect(keeper.get(game)).toBe("ana");
  applyWorldEntries(game, hostA, {
    "entity/well.water": 7,
    "entity/well.keeper": [-1, "bo"],
  });
  expect(water.get(game)).toBe(3);
  expect(keeper.get(game)).toBe("ana");
});

test("from one host and term, an entry no newer than the one held is ignored", () => {
  const { game, water } = withWell();
  applyWorldEntries(game, hostA, { "entity/well.water": [3, 30] });
  applyWorldEntries(game, hostA, { "entity/well.water": [2, 20] });
  applyWorldEntries(game, hostA, { "entity/well.water": [3, 31] });
  expect(water.get(game)).toBe(30);
  applyWorldEntries(game, hostA, { "entity/well.water": [4, 40] });
  expect(water.get(game)).toBe(40);
});

test("a host of another term or id replaces what an earlier one sent, whatever its version", () => {
  const { game, water } = withWell();
  applyWorldEntries(game, hostA, { "entity/well.water": [9, 90] });
  applyWorldEntries(
    game,
    { host: "b", term: 1 },
    {
      "entity/well.water": [2, 20],
    },
  );
  expect(water.get(game)).toBe(20);
  applyWorldEntries(
    game,
    { host: "b", term: 2 },
    {
      "entity/well.water": [1, 10],
    },
  );
  expect(water.get(game)).toBe(10);
});

test("a client that takes over counts on from the version it holds", () => {
  const { game, water } = withWell();
  game.hosting = false;
  applyWorldEntries(game, hostA, { "entity/well.water": [5, 50] });
  game.hosting = true;
  water.set(game, 60);
  expect(takeWorldEntries(game, false)).toEqual({
    "entity/well.water": [6, 60],
  });
});

test("a name registered twice throws", () => {
  const game = session();
  const water = worldData({ schema: Count, initial: 0 });
  const entry = {
    world: { water },
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
