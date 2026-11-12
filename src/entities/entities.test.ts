import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession } from "../sim/index.js";
import { entityContent } from "./index.js";

test("the content list numbers the chaser 1 and the cruiser 2, and a new world starts with chasers and a cruiser at the rally point", () => {
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
    ["chaser", 1],
    ["cruiser", 2],
  ]);
  const entities = [...game.entities.values()];
  expect(entities.map(({ kind }) => kind)).toEqual([1, 1, 2]);
  expect(entities.at(-1)).toMatchObject(game.rally);
});
