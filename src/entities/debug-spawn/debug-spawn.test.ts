import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { itemContent } from "../../items/index.js";
import { createSession, registerContent } from "../../sim/index.js";
import type { TileMap } from "../../sim/index.js";
import { entityContent } from "../index.js";
import { spawnChoices, spawnPointAhead } from "./index.js";

/** A corridor 20 cells of 10px long and 3 high, a wall filling its 9th column. */
function corridor(): TileMap {
  const cols = 20;
  const rows = 3;
  const solid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) solid[row * cols + 8] = 1;
  return { cell: 10, cols, rows, solid };
}

test("a spawn lands the full distance ahead the way the asker faces, on open floor", () => {
  const map = corridor();
  const at = spawnPointAhead(map, { x: 115, y: 15 }, 0, 60, 4);
  expect(at.x).toBeCloseTo(175);
  expect(at.y).toBeCloseTo(15);
});

test("a wall across the way stops a spawn short of it, where the body still fits", () => {
  const map = corridor();
  const at = spawnPointAhead(map, { x: 15, y: 15 }, 0, 100, 4);
  expect(at.x).toBeLessThanOrEqual(80 - 4);
  expect(at.x).toBeGreaterThan(80 - 4 - 4);
  expect(at.y).toBeCloseTo(15);
});

test("a spawn facing a wall it cannot fit before lands at the nearest free spot", () => {
  const map = corridor();
  const at = spawnPointAhead(map, { x: 78, y: 15 }, 0, 100, 4);
  expect(at.x).toBeLessThanOrEqual(76);
});

test("the menu offers every kind the spawner brings, then every item", () => {
  const game = createSession(
    "me",
    "ME",
    "MENU",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    ...entityContent(testEntitiesConfig),
    ...itemContent(testItemsConfig),
  ]);
  const choices = spawnChoices(game);
  const monsters = choices.filter((choice) => choice.what === "monster");
  const items = choices.filter((choice) => choice.what === "item");
  expect(monsters.map((choice) => choice.kind)).toContain("zombie");
  expect(items.map((choice) => choice.kind)).toContain("shovel");
  expect(items).toHaveLength(game.itemDefinitions.size);
  expect(choices).toEqual([...monsters, ...items]);
});
