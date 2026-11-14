import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { defineItem, registerContent, setDanger } from "./index.js";
import type { ItemDefinition } from "./inventory.js";
import { lootContent, pickLoot } from "./loot.js";
import type { LootConfig } from "./loot.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";
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
      danger: { road: 0, right: 0 },
    },
  };
  expect(laid(populated(40, undefined, safe))).toHaveLength(40);
  expect(laid(populated(40)).length).toBeGreaterThan(45);
});
