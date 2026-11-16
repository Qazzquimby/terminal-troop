import { meanBy } from "lodash-es";
import { expect, test } from "vitest";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import { createSession, dangerWeight, registerContent } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { testItemsConfig, testSfx, testSimConfig } from "./sim-config.js";

/** A new world laying 30 plain scrap and 30 golden, each by its own pull towards danger. */
function laidWorld(room: string): Session {
  const items: ItemsConfig = {
    ...testItemsConfig,
    scrap: {
      ...testItemsConfig.scrap,
      scatter: { count: 30, seed: 2, clearance: 0, danger: 1 },
    },
    goldenScrap: {
      ...testItemsConfig.goldenScrap,
      scatter: { count: 30, seed: 3, clearance: 0, danger: 3 },
    },
  };
  const game = createSession(
    "me",
    "ME",
    room,
    "standard",
    testSfx(),
    testSimConfig,
  );
  const contents = itemContent(items);
  registerContent(game, contents);
  for (const content of contents) content.populate(game);
  return game;
}

/** The danger weight of each lying `item` in `game`. */
function dangers(game: Session, item: string): number[] {
  return [...game.entities.values()]
    .filter((entity) => JSON.stringify(entity.data).includes(`"${item}"`))
    .map((entity) => dangerWeight(game.world, entity));
}

test("golden scrap lies deeper in danger than plain scrap", () => {
  for (const room of ["GOLD1", "GOLD2", "GOLD3"]) {
    const game = laidWorld(room);
    const plain = dangers(game, "scrap");
    const golden = dangers(game, "goldenScrap");
    expect(plain).toHaveLength(30);
    expect(golden).toHaveLength(30);
    expect(meanBy(golden)).toBeGreaterThan(meanBy(plain));
  }
});

test("golden scrap glints gold, and plain scrap does not", () => {
  const game = laidWorld("GOLD1");
  expect(game.itemDefinitions.get("goldenScrap")?.glint).toBeDefined();
  expect(game.itemDefinitions.get("scrap")?.glint).toBeUndefined();
  expect(game.itemDefinitions.get("goldenScrap")?.emoji).toBe(
    game.itemDefinitions.get("scrap")?.emoji,
  );
});
