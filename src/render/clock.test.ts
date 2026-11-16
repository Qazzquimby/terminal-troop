import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { AREA, createSession } from "../sim/index.js";
import { showsClock } from "./clock.js";

test("the clock shows to a body on the road, lit or not, and nowhere else", () => {
  const game = createSession(
    "me",
    "ME",
    "CLOCK",
    "standard",
    testSfx(),
    testSimConfig,
  );
  const { area } = game.world.layout;
  const { cell, cols } = game.world.map;
  const centreOf = (i: number) => ({
    x: ((i % cols) + 0.5) * cell,
    y: (Math.floor(i / cols) + 0.5) * cell,
  });
  const road = centreOf(area.indexOf(AREA.road));
  expect(showsClock(game, road)).toBe(true);
  game.worldTime = testSimConfig.day.night;
  expect(showsClock(game, road)).toBe(true);
  expect(showsClock(game, centreOf(area.indexOf(AREA.room)))).toBe(false);
  expect(showsClock(game, centreOf(area.indexOf(AREA.yard)))).toBe(false);
});
