import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession } from "../sim/index.js";
import { entityContent } from "./index.js";

test("the content list numbers its kinds from 1 in its order, the zombie 1 and the cruiser 2, and a new world starts with zombies and a cruiser at the rally point", () => {
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

  // Derived rather than written out, so a kind added to the list does not touch this test.
  const kinds = [...game.kindIds];
  expect(kinds.map(([, id]) => id)).toEqual(kinds.map((_, index) => index + 1));
  expect(kinds.slice(0, 2)).toEqual([
    ["zombie", 1],
    ["cruiser", 2],
  ]);
  const entities = [...game.entities.values()];
  expect(entities.map(({ kind }) => kind)).toEqual([1, 1, 2]);
  expect(entities.at(-1)).toMatchObject(game.rally);
});
