import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  emittedLights,
  isLit,
  registerContent,
} from "../../sim/index.js";
import type { EntitiesConfig } from "../index.js";
import { entityContent } from "../index.js";

const { headlights } = testEntitiesConfig.cruiser;

test("the cruiser always shines two headlights ahead, from either side of its front", () => {
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
    },
  };
  const game = createSession("me", "ME", "LAMPS", "dev", testSfx(), {
    ...testSimConfig,
  });
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  const [cruiser] = game.entities.values();
  if (cruiser === undefined) throw new Error("no cruiser");
  Object.assign(cruiser, { x: 200, y: 300 });

  const lights = emittedLights(game);
  expect(lights).toHaveLength(2);
  const ys = lights.map((light) => light.y - cruiser.y).sort((a, b) => a - b);
  expect(ys).toEqual([-headlights.spread, headlights.spread]);
  for (const light of lights) {
    expect(light.x).toBeGreaterThan(cruiser.x);
    expect(light.range).toBe(headlights.range);
    expect(light.shape).toEqual({
      kind: "cone",
      direction: 0,
      angle: headlights.angle,
    });
  }

  expect(isLit(game, { x: 500, y: 300 })).toBe(true);
  expect(isLit(game, { x: 100, y: 300 })).toBe(false);
  expect(isLit(game, { x: 200, y: 500 })).toBe(false);
});
