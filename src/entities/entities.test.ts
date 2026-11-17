import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession } from "../sim/index.js";
import { entityContent } from "./index.js";

test("the content list numbers the zombie 1, the cruiser 2, the stun trap 3, the snail 4, the blind dog 5, the exploder 6, the sleeper 7, the statue 8, the stalker 9, the hoarder 10, the land mine 11, the mine layer 12, the turret 13, the teleporter 14, the giant snail 15, the living wall 16, the gloom 17, the recall 18, the pocketball 19, the ghost girl 20, the doppelganger 21, the bomb 22 and the flare 23, and a new world starts with zombies and a cruiser at the rally point", () => {
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
    ["blindDog", 5],
    ["exploder", 6],
    ["sleeper", 7],
    ["statue", 8],
    ["stalker", 9],
    ["hoarder", 10],
    ["landMine", 11],
    ["mineLayer", 12],
    ["turret", 13],
    ["teleporter", 14],
    ["giantSnail", 15],
    ["livingWall", 16],
    ["gloom", 17],
    ["recall", 18],
    ["pocketball", 19],
    ["ghostGirl", 20],
    ["doppelganger", 21],
    ["bomb", 22],
    ["flare", 23],
  ]);
  const entities = [...game.entities.values()];
  expect(entities.map(({ kind }) => kind)).toEqual([1, 1, 2]);
  expect(entities.at(-1)).toMatchObject(game.rally);
});
