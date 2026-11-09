import { expect, test } from "vitest";
import {
  testMonsterConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  createSession,
  isAreaFree,
  mulberry32,
  randomFreePosition,
} from "../sim/index.js";
import type { Session, WorldKind } from "../sim/index.js";
import { ChaserState } from "./chaser.js";
import type { MonsterConfig } from "./index.js";
import { MonsterKind, createMonsters } from "./index.js";

function populated(
  code: string,
  kind: WorldKind = "standard",
  config: MonsterConfig = testMonsterConfig,
): Session {
  const game = createSession("me", "ME", code, kind, testSfx(), testSimConfig);
  // Players start at random; this one stands at the same spot every time.
  Object.assign(game.local, randomFreePosition(game.world, 14, mulberry32(9)));
  const monsters = createMonsters(config);
  monsters.register(game);
  monsters.populate(game);
  return game;
}

const placed = (game: Session) =>
  [...game.entities.values()].map(({ x, y }) => ({ x, y }));

test("spawns chasers by the area of the world, on free floor, wandering", () => {
  const game = populated("SPAWN");
  const entities = [...game.entities.values()];
  // 4000x3000 at 0.25 per million square pixels.
  expect(entities).toHaveLength(3);
  for (const entity of entities) {
    expect(entity.kind).toBe(MonsterKind.CHASER);
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

test("spawns away from the players", () => {
  const game = populated("SPAWN");
  for (const { x, y } of placed(game)) {
    expect(
      Math.hypot(x - game.local.x, y - game.local.y),
    ).toBeGreaterThanOrEqual(testMonsterConfig.clearance);
  }
});

test("a world too small for the clearance still spawns them, as far off as it can", () => {
  const game = populated("SPAWN", "dev");
  expect(game.entities.size).toBe(testMonsterConfig.minChasers);
});

test("a denser world spawns more", () => {
  const dense = { ...testMonsterConfig, chaserDensity: 1 };
  expect(populated("SPAWN", "standard", dense).entities.size).toBe(12);
});

test("the spots are seeded by the room", () => {
  expect(placed(populated("SPAWN"))).toEqual(placed(populated("SPAWN")));
  expect(placed(populated("SPAWN"))).not.toEqual(placed(populated("OTHER")));
});
