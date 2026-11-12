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
import type { ContentName, WorldContent } from "./index.js";

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
    "core/items": null,
    "core/movement": { mode: "walk", moving: false },
    "core/voice": 0,
    "entity/bat": "Infinity",
    "item/torch": true,
  });
});

test("every session reports the held item, how it moves and how far its speech carries, with no content listed", () => {
  const game = session();
  registerContent(game, []);
  expect(playerState(game).content).toEqual({
    "core/items": null,
    "core/movement": { mode: "walk", moving: false },
    "core/voice": 0,
  });
});

test("content is named for where it comes from, and only the engine's own is core", () => {
  expectTypeOf<"entity/lamp">().toExtend<ContentName>();
  expectTypeOf<"item/lamp">().toExtend<ContentName>();
  expectTypeOf<"core/items">().not.toExtend<ContentName>();
  expectTypeOf<"lamp">().not.toExtend<ContentName>();
});

test("an entity and an item of the same name keep their own state", () => {
  const game = session();
  const glow = playerData({ schema: z.number(), initial: () => 1 });
  const fuel = playerData({ schema: z.number(), initial: () => 2 });
  registerContent(game, [
    defineEntity("lamp", () => ({
      ...shape,
      data: z.object({}),
      player: glow,
    })).create({ lamp: undefined }),
    defineItem("lamp", () => ({
      name: "Lamp",
      emoji: "🪔",
      player: fuel,
      cooldown: 1,
      apply: () => undefined,
      show: (_game, at) => ({ center: at, hit: false }),
      draw: () => undefined,
    })).create({ lamp: undefined }),
  ]);
  expect(playerState(game).content).toEqual({
    "core/items": null,
    "core/movement": { mode: "walk", moving: false },
    "core/voice": 0,
    "entity/lamp": 1,
    "item/lamp": 2,
  });
});

test("a remote player's reported values are decoded by each entry's own schema", () => {
  const game = session();
  const ammo = playerData({ schema: Count, initial: () => 0 });
  registerContent(game, [
    {
      name: "item/gun",
      player: ammo,
      register: () => undefined,
      populate: () => undefined,
    },
  ]);
  applyRemoteState(game, {
    ...playerState(game),
    id: "them",
    content: { "item/gun": "Infinity" },
  });
  const them = game.players.get("them");
  expect(them === undefined ? undefined : ammo.get(them)).toBe(Infinity);
});

test("a content name used twice throws", () => {
  const game = session();
  const entry = (name: ContentName): WorldContent => ({
    name,
    register: () => undefined,
    populate: () => undefined,
  });
  expect(() => {
    registerContent(game, [
      entry("item/a"),
      entry("entity/a"),
      entry("item/a"),
    ]);
  }).toThrow("Content name used twice: item/a");
});
