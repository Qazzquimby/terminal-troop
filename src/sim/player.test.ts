import { expect, test } from "vitest";
import type { World } from "./map.js";
import type { Player, PlayerRules } from "./player.js";
import { createPlayer, updatePlayer } from "./player.js";

const STEP = 1 / 60;
const PLAYER_SPEED = 220;
const SPRINT_MULTIPLIER = 1.8;
const STAMINA_MAX = 100;

const rules: PlayerRules = {
  player: {
    radius: 14,
    speed: PLAYER_SPEED,
    acceleration: 1100,
    sprintMultiplier: SPRINT_MULTIPLIER,
    inventorySlots: 4,
    nameMax: 8,
  },
  stamina: {
    max: STAMINA_MAX,
    drain: STAMINA_MAX / 3,
    regen: STAMINA_MAX / 4,
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3,
  },
  world: { cell: 50, cols: 100, rows: 100, seed: 1, wallBounce: 0 },
};

function openWorld(): World {
  const map = { cell: 50, cols: 100, rows: 100, solid: new Uint8Array(10000) };
  return { W: 5000, H: 5000, map };
}

function run(player: Player, world: World, sprint: boolean, steps: number) {
  const controls = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, sprint };
  for (let i = 0; i < steps; i++) {
    updatePlayer(player, controls, STEP, world.map, rules);
  }
}

function startPlayer(world: World): Player {
  const player = createPlayer("p", "P", world, rules);
  player.x = 500;
  player.y = 2500;
  return player;
}

test("walking reaches normal top speed", () => {
  const world = openWorld();
  const player = startPlayer(world);
  run(player, world, false, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);
});

test("holding sprint reaches the higher top speed", () => {
  const world = openWorld();
  const player = startPlayer(world);
  run(player, world, true, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * SPRINT_MULTIPLIER);
});

test("releasing sprint decelerates back to normal speed", () => {
  const world = openWorld();
  const player = startPlayer(world);
  run(player, world, true, 60);

  run(player, world, false, 1);
  expect(player.vx).toBeLessThan(PLAYER_SPEED * SPRINT_MULTIPLIER);
  expect(player.vx).toBeGreaterThan(PLAYER_SPEED);

  run(player, world, false, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);
});

test("holding sprint while standing still does not drain stamina", () => {
  const world = openWorld();
  const player = startPlayer(world);
  const controls = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, sprint: true };
  for (let i = 0; i < 300; i++) {
    updatePlayer(player, controls, STEP, world.map, rules);
  }
  expect(player.stamina.value).toBe(STAMINA_MAX);
});

test("running out of stamina drops sprint to walk speed until recovered", () => {
  const world = openWorld();
  const player = startPlayer(world);
  run(player, world, true, 60 * 4);
  expect(player.stamina.exhausted).toBe(true);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);

  // Sprint stays held: exhausted players walk and regenerate.
  while (player.stamina.exhausted) {
    run(player, world, true, 1);
    expect(player.vx).toBeLessThanOrEqual(PLAYER_SPEED);
  }
  run(player, world, true, 15);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * SPRINT_MULTIPLIER);
});
