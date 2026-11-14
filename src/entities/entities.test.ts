import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession } from "../sim/index.js";
import { entityContent } from "./index.js";

test("the content list numbers the zombie 1, the cruiser 2, the stun trap 3 and the snail 4, and a new world starts with zombies and a cruiser at the rally point", () => {
  const game = createSession(
    "me",
    "ME",
    "LIST",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 400, y: 300 });
  const content = entityContent(testEntitiesConfig);
  for (const entry of content) entry.register(game);
  for (const entry of content) entry.populate(game);

  expect([...game.kindIds]).toEqual([
    ["zombie", 1],
    ["cruiser", 2],
    ["stunTrap", 3],
    ["snail", 4],
  ]);
  const entities = [...game.entities.values()];
  expect(entities.map(({ kind }) => kind)).toEqual([1, 1, 2]);
  expect(entities.at(-1)).toMatchObject(game.rally);
});
