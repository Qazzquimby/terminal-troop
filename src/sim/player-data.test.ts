import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyRemoteState,
  createSession,
  defineEntity,
  defineItem,
  playerData,
  playerState,
  registerContent,
} from "./index.js";
import type { WorldContent } from "./index.js";

function session() {
  return createSession("me", "ME", "DATA", "dev", testSfx(), testSimConfig);
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

const shape = { radius: 10, maxHealth: 10, draw: () => undefined };

test("a value reads as its initial one, made from the player, until it is set", () => {
  const game = session();
  const tag = playerData({
    schema: z.string(),
    initial: (player) => `${player.name}!`,
  });
  expectTypeOf(tag.get(game.local)).toEqualTypeOf<string>();
  expect(tag.get(game.local)).toBe("ME!");
  tag.set(game.local, "set");
  expect(tag.get(game.local)).toBe("set");
});

test("a value is kept on the player in its wire form", () => {
  const game = session();
  const ammo = playerData({ schema: Count, initial: () => 0 });
  ammo.set(game.local, Infinity);
  expect(game.local.content.get(ammo)).toBe("Infinity");
  expect(ammo.get(game.local)).toBe(Infinity);
  expect(() => {
    ammo.set(game.local, 1.5);
  }).toThrow();
});

test("a STATE carries each registered entry's value, encoded, by the entry's name", () => {
  const game = session();
  const ammo = playerData({ schema: Count, initial: () => Infinity });
  const lit = playerData({ schema: z.boolean(), initial: () => false });
  registerContent(game, [
    defineEntity("bat", () => ({
      ...shape,
      data: z.object({}),
      player: ammo,
    })).create({
      bat: undefined,
    }),
    defineItem("torch", () => ({
      name: "Torch",
      maxStack: 1,
      emoji: "🔦",
      player: lit,
      cooldown: 1,
      apply: () => undefined,
      show: (_game, at) => ({ center: at, hit: false }),
      draw: () => undefined,
    })).create({ torch: undefined }),
  ]);
  lit.set(game.local, true);
  expect(playerState(game).content).toEqual({
    held: null,
    bat: "Infinity",
    torch: true,
  });
});

test("every session reports the held item, with no content listed", () => {
  const game = session();
  registerContent(game, []);
  expect(playerState(game).content).toEqual({ held: null });
});

test("content may not take a name the engine keeps for its own", () => {
  const game = session();
  const held: WorldContent = {
    name: "held",
    register: () => undefined,
    populate: () => undefined,
  };
  expect(() => {
    registerContent(game, [held]);
  }).toThrow("Content name reserved by the engine: held");
});

test("a remote player's reported values are decoded by each entry's own schema", () => {
  const game = session();
  const ammo = playerData({ schema: Count, initial: () => 0 });
  registerContent(game, [
    {
      name: "gun",
      player: ammo,
      register: () => undefined,
      populate: () => undefined,
    },
  ]);
  applyRemoteState(game, {
    ...playerState(game),
    id: "them",
    content: { gun: "Infinity" },
  });
  const them = game.players.get("them");
  expect(them === undefined ? undefined : ammo.get(them)).toBe(Infinity);
});

test("a content name used twice throws", () => {
  const game = session();
  const entry = (name: string): WorldContent => ({
    name,
    register: () => undefined,
    populate: () => undefined,
  });
  expect(() => {
    registerContent(game, [entry("a"), entry("b"), entry("a")]);
  }).toThrow("Content name used twice: a");
});
