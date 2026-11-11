import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  isAreaFree,
  mulberry32,
  randomFreePosition,
} from "../../sim/index.js";
import type { Session } from "../../sim/index.js";
import { ChaserState, chaser } from "./index.js";

function populated(code: string): Session {
  const game = createSession(
    "me",
    "ME",
    code,
    "standard",
    testSfx(),
    testSimConfig,
  );
  // Players start at random; this one stands at the same spot every time.
  Object.assign(game.local, randomFreePosition(game.world, 14, mulberry32(9)));
  const content = chaser.create(testEntitiesConfig);
  content.register(game);
  content.populate(game);
  return game;
}

test("a new world scatters chasers by its area, on free floor, wandering", () => {
  const game = populated("SPAWN");
  const entities = [...game.entities.values()];
  // 4000x3000 at 0.25 per million square pixels.
  expect(entities).toHaveLength(3);
  for (const entity of entities) {
    expect(entity.kind).toBe(game.kindIds.get("chaser"));
    expect(isAreaFree(game.world.map, entity.x, entity.y, entity.radius)).toBe(
      true,
    );
    expect(ChaserState.parse(entity.data).mode).toBe("wander");
  }
});

test("each chaser draws from its own seed", () => {
  const seeds = [...populated("SPAWN").entities.values()].map(
    (entity) => ChaserState.parse(entity.data).seed,
  );
  expect(new Set(seeds).size).toBe(seeds.length);
});
