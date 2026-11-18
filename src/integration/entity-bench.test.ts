import { expect, test } from "vitest";
import type { BenchConfig } from "./entity-bench.js";
import {
  benchDefaults,
  byKind,
  byPhase,
  REGIMES,
  runBench,
} from "./entity-bench.js";
import {
  testEntitiesConfig,
  testFlashConfig,
  testItemsConfig,
  testMapMemoryConfig,
  testMovesConfig,
  testRippleConfig,
  testSimConfig,
} from "./sim-config.js";

// A smoke test of the entity benchmark (#433), so it keeps running as the game changes; the
// sweep itself, on the shipped config, is `pnpm bench:entities`.

/**
 * The test config, monsters engaging within 500px of a player, and the spawner bringing zombies,
 * dormant past 1500px, and exploders, which never lie dormant.
 */
const small: BenchConfig = {
  sim: { ...testSimConfig, engagement: { range: 500 } },
  entities: {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      dormantBeyond: 1500,
      // None scattered as the world starts: the bench places them all.
      spawn: {
        ...testEntitiesConfig.zombie.spawn,
        count: { density: 0, min: 0 },
      },
      spawning: { ...testEntitiesConfig.zombie.spawning, weight: 2 },
    },
    exploder: {
      ...testEntitiesConfig.exploder,
      spawning: { ...testEntitiesConfig.exploder.spawning, weight: 1 },
    },
  },
  items: testItemsConfig,
  moves: testMovesConfig,
  clock: { fixedDt: 1 / 60, maxCatchUpS: 1, maxStepsPerFrame: 4 },
  sendHz: 10,
  camera: {
    zoom: 1,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
    roll: { rate: 10, anchor: 0.5 },
  },
  flashes: testFlashConfig,
  ripples: testRippleConfig,
  mapMemory: testMapMemoryConfig,
};

test.each(REGIMES)("the entity bench runs the %s regime", (regime) => {
  const result = runBench(small, {
    ...benchDefaults,
    regime,
    count: 6,
    warmup: 2,
    steps: 3,
  });
  expect(result.kinds.get("zombie")).toBe(4);
  expect(result.kinds.get("exploder")).toBe(2);
  expect(result.step.mean).toBeGreaterThan(0);
  expect(result.draw?.mean).toBeGreaterThan(0);
  expect(byPhase(result.parts).map(([phase]) => phase)).toContain("entities");
  expect(byKind(result.parts).map(([kind]) => kind)).toContain("zombie");
});

test("a dormant zombie is timed standing still, an active one running", () => {
  const timed = (regime: "dormant" | "active") =>
    runBench(small, { ...benchDefaults, regime, count: 2, warmup: 1, steps: 2 })
      .parts.map(([label]) => label)
      .filter((label) => label.startsWith("kind:zombie:"));
  expect(timed("dormant")).toContain("kind:zombie:still");
  expect(timed("dormant")).not.toContain("kind:zombie:run");
  expect(timed("active")).toContain("kind:zombie:run");
});
