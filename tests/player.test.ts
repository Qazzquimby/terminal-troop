import { expect, test } from "vitest";
import { PLAYER_SPEED, SPRINT_MULTIPLIER } from "../src/engine/config.js";
import type { World } from "../src/engine/map.js";
import type { Player } from "../src/engine/player.js";
import { createPlayer, updatePlayer } from "../src/engine/player.js";

const STEP = 1 / 60;

function openWorld(): World {
  const map = { cell: 50, cols: 100, rows: 100, solid: new Uint8Array(10000) };
  return { W: 5000, H: 5000, map };
}

function run(player: Player, world: World, sprint: boolean, steps: number) {
  const controls = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, sprint };
  for (let i = 0; i < steps; i++) {
    updatePlayer(player, controls, STEP, world.map);
  }
}

function startPlayer(world: World): Player {
  const player = createPlayer("p", "P", world);
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
