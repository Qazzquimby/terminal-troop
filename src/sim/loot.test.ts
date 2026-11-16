import { meanBy } from "lodash-es";
import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { defineItem, registerContent, setDanger } from "./index.js";
import type { ItemDefinition } from "./inventory.js";
import { lootContent, pickLoot } from "./loot.js";
import type { LootConfig } from "./loot.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";
import { danger as dangerOf, isAreaFree } from "./map.js";
import type { WorldConfig } from "./map.js";

const DANGER: LootConfig["danger"] = {
  extra: 1,
  rarity: { common: 1, uncommon: 2, rare: 4 },
};

const shovel: ItemDefinition = {
  id: "shovel",
  name: "Shovel",
  emoji: "🪏",
  loot: { weight: 30, rarity: "common" },
};
const handgun: ItemDefinition = {
  id: "handgun",
  name: "Handgun",
  emoji: "🔫",
  loot: { weight: 10, rarity: "rare" },
};
const scrap: ItemDefinition = { id: "scrap", name: "Scrap", emoji: "🔩" };

/** How many of `draws` evenly spread draws pick each item, at a spot of `danger`. */
function tally(danger: number, draws = 400): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let draw = 0; draw < draws; draw++) {
    const picked = pickLoot(
      [shovel, handgun, scrap],
      danger,
      DANGER,
      () => (draw + 0.5) / draws,
    );
    const id = picked?.id ?? "none";
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

test("items are picked in proportion to their loot weights; one with none never is", () => {
  expect(tally(0)).toEqual({ shovel: 300, handgun: 100 });
});

test("at a dangerous spot each rarity's weight follows its curve", () => {
  // Full danger: the rare handgun's 10 counts as 40, against the common shovel's 30.
  const full = tally(1, 700);
  expect(full).toEqual({ shovel: 300, handgun: 400 });
  // Half danger: 10 counts as 25.
  expect(tally(0.5, 550)).toEqual({ shovel: 300, handgun: 250 });
});

test("with nothing weighted, nothing is picked", () => {
  expect(pickLoot([scrap], 0, DANGER, () => 0.5)).toBeNull();
});

const pick = (id: string, weight: number) =>
  defineItem(id, () => ({
    name: id,
    emoji: "?",
    traits: { weight: 1, loot: { weight, rarity: "common" as const } },
  })).create({ [id]: undefined });

function populated(
  count: number,
  danger?: number,
  world: WorldConfig = testSimConfig.world,
): Session {
  const game = createSession("me", "ME", "LOOT", "standard", testSfx(), {
    ...testSimConfig,
    world,
  });
  const loot = lootContent({
    scatter: { count, seed: 1, clearance: 0 },
    guaranteed: [],
    danger: DANGER,
  });
  registerContent(game, [pick("lamp", 1), loot]);
  if (danger !== undefined) setDanger(game, () => danger);
  loot.populate(game);
  return game;
}

const laid = (game: Session): string[] =>
  [...game.entities.values()].map((entity) => JSON.stringify(entity.data));

test("a new world lays an item at each spot of the loot's scatter", () => {
  const game = populated(12, 0);
  expect(laid(game)).toEqual(Array(12).fill(JSON.stringify({ item: "lamp" })));
});

test("where it is dangerous, a spot may lay a second item; a safe one never does", () => {
  expect(laid(populated(12, 0))).toHaveLength(12);
  expect(laid(populated(12, 1))).toHaveLength(24);
});

test("a new world's danger is its layout's: none where nothing is dangerous, some where it is", () => {
  const safe = {
    ...testSimConfig.world,
    generation: {
      ...testSimConfig.world.generation,
      danger: { road: 0, right: 0, exit: 0, reach: 0 },
    },
  };
  expect(laid(populated(40, undefined, safe))).toHaveLength(40);
  expect(laid(populated(40)).length).toBeGreaterThan(45);
});

/**
 * A world with no rolled loot and `count` of `item` guaranteed, spread across its width, each
 * drawn within its band by danger weight raised to `danger`.
 */
function guaranteed(
  count: number,
  room = "LOOT",
  item = "can",
  danger = 0,
): Session {
  const game = createSession(
    "me",
    "ME",
    room,
    "standard",
    testSfx(),
    testSimConfig,
  );
  const loot = lootContent({
    scatter: { count: 0, seed: 1, clearance: 0 },
    guaranteed: [
      { item, scatter: { count, seed: 2, clearance: 0, spread: "x", danger } },
    ],
    danger: DANGER,
  });
  registerContent(game, [pick("can", 0), loot]);
  loot.populate(game);
  return game;
}

const spots = (game: Session) =>
  [...game.entities.values()].map(({ x, y }) => ({ x, y }));

test("a guaranteed item is laid its count of times, though the loot never picks it", () => {
  expect(laid(guaranteed(15))).toEqual(
    Array(15).fill(JSON.stringify({ item: "can" })),
  );
});

test("guaranteed items spread one to each equal band across the world's width", () => {
  const game = guaranteed(15);
  const band = game.world.W / 15;
  const bands = spots(game)
    .map(({ x }) => Math.floor(x / band))
    .sort((a, b) => a - b);
  expect(bands).toEqual([...Array(15).keys()]);
});

test("guaranteed items lie only where a body of their size is free", () => {
  const game = guaranteed(15);
  const { radius } = game.config.worldItems;
  for (const { x, y } of spots(game))
    expect(isAreaFree(game.world.map, x, y, radius)).toBe(true);
});

test("the same room lays its guaranteed items at the same spots; another room elsewhere", () => {
  expect(spots(guaranteed(15))).toEqual(spots(guaranteed(15)));
  expect(spots(guaranteed(15, "OTHER"))).not.toEqual(spots(guaranteed(15)));
});

test("guaranteed items favouring danger still lie one to each band, but further from the road", () => {
  const game = guaranteed(30, "LOOT", "can", 2);
  const band = game.world.W / 30;
  const bands = spots(game)
    .map(({ x }) => Math.floor(x / band))
    .sort((a, b) => a - b);
  expect(bands).toEqual([...Array(30).keys()]);
  expect(meanDanger(game)).toBeGreaterThan(
    meanDanger(guaranteed(30, "LOOT", "can", 0)) + 0.05,
  );
});

test("guaranteed loot naming no item is an error", () => {
  expect(() => guaranteed(1, "LOOT", "nothing")).toThrow(/nothing/);
});

/** A world of only rolled lamps, `count` spots of `scatter`'s danger, no second item at any. */
function lamps(count: number, danger: number): Session {
  const game = createSession(
    "me",
    "ME",
    "LOOT",
    "standard",
    testSfx(),
    testSimConfig,
  );
  const loot = lootContent({
    scatter: { count, seed: 1, clearance: 0, danger },
    guaranteed: [],
    danger: { ...DANGER, extra: 0 },
  });
  registerContent(game, [pick("lamp", 1), loot]);
  loot.populate(game);
  return game;
}

/** The mean danger, 0..1, of where `game`'s loot lies. */
function meanDanger(game: Session): number {
  return meanBy(spots(game), (spot) => dangerOf(game.world, spot));
}

test("loot favours dangerous spots, where monsters spawn, as strongly as its scatter's danger says", () => {
  const even = meanDanger(lamps(60, 0));
  const favoured = meanDanger(lamps(60, 1));
  expect(favoured).toBeGreaterThan(even + 0.1);
  expect(meanDanger(lamps(60, 3))).toBeGreaterThan(favoured);
  expect(spots(lamps(60, 1))).toHaveLength(60);
});

/** A world of only `count` bolts, laid by their own scatter, as scrap is, favouring danger by `danger`. */
function bolts(count: number, danger: number): Session {
  const game = createSession(
    "me",
    "ME",
    "LOOT",
    "standard",
    testSfx(),
    testSimConfig,
  );
  const bolt = defineItem("bolt", () => ({
    name: "Bolt",
    emoji: "?",
    scatter: { count, seed: 3, clearance: 0, danger },
  })).create({ bolt: undefined });
  registerContent(game, [bolt]);
  bolt.populate(game);
  return game;
}

test("an item scattered by itself, as scrap is, favours dangerous spots by its scatter's danger", () => {
  expect(spots(bolts(200, 1))).toHaveLength(200);
  expect(meanDanger(bolts(200, 1))).toBeGreaterThan(
    meanDanger(bolts(200, 0)) + 0.1,
  );
});
