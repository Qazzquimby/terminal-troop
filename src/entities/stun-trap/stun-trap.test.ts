import { expect, test } from "vitest";
import { reportedAt } from "../../integration/heard.js";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  emittedLights,
  isStunned,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import {
  freshZombie,
  zombie as zombieContent,
  ZombieState,
} from "../zombie/index.js";
import { placeStunTrap, stunTrap, TrapState } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};
const config = testEntitiesConfig.stunTrap;

/**
 * The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550, with zombies and
 * stun traps; the player stands in its far corner.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "TRAP",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    stunTrap.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x: 750, y: 560, prevX: 750, prevY: 560 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

function zombieAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(
    game,
    "zombie",
    x,
    y,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
}

/** The world's one stun trap, put down at `at`. */
function trapAt(game: Session, x: number, y: number): WorldEntity {
  placeStunTrap(game, { x, y });
  const trap = [...game.entities.values()].at(-1);
  if (trap === undefined) throw new Error("No trap was put down");
  return trap;
}

const armed = (trap: WorldEntity) => TrapState.parse(trap.data).armed;

test("a trap arms once its arming time is up, and nothing sets it off before", () => {
  const game = world();
  const trap = trapAt(game, 400, 300);
  run(game, config.armSeconds - 0.2);
  expect(armed(trap)).toBe(false);
  // A zombie walks over it while it is still arming.
  const zombie = zombieAt(game, 400, 300);
  run(game, DT);
  expect(isStunned(game, zombie.id)).toBe(false);
  game.entities.delete(zombie.id);
  run(game, 0.3);
  expect(armed(trap)).toBe(true);
  expect(game.entities.has(trap.id)).toBe(true);
});

/** Turns `zombie` to face `facing`, in radians. */
function face(zombie: WorldEntity, facing: number): WorldEntity {
  zombie.data = { ...ZombieState.parse(zombie.data), facing };
  return zombie;
}

test("an armed trap goes off under an entity, stunning those whose eyes see it within range", () => {
  const game = world();
  const trap = trapAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);

  // Facing the trap, down its cone.
  const near = face(zombieAt(game, 400 + config.stunRange - 20, 300), Math.PI);
  // Back turned, the trap well past the small circle it sees all round it.
  const turned = face(zombieAt(game, 400, 300 - config.stunRange + 20), 0);
  // Back turned, but the trap within that small circle.
  const close = face(zombieAt(game, 400, 340), 0);
  // Behind the pillar at x 200-300, y 50-150.
  const hidden = zombieAt(game, 250, 30);
  const far = zombieAt(game, 400, 300 + config.stunRange + 40);
  const stepper = zombieAt(game, 405, 300);
  run(game, DT * 2);

  expect(isStunned(game, stepper.id)).toBe(true);
  expect(isStunned(game, near.id)).toBe(true);
  expect(isStunned(game, close.id)).toBe(true);
  expect(isStunned(game, turned.id)).toBe(false);
  expect(isStunned(game, hidden.id)).toBe(false);
  expect(isStunned(game, far.id)).toBe(false);
  expect(isStunned(game, trap.id)).toBe(false);
});

test("its flash lights a wide circle for a moment, and then the trap is gone", () => {
  const game = world();
  const trap = trapAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  expect(emittedLights(game)).toHaveLength(0);
  zombieAt(game, 400, 300);
  run(game, DT * 2);

  expect(emittedLights(game)).toEqual([
    expect.objectContaining({ x: 400, y: 300, range: config.light.range }),
  ]);
  run(game, config.light.seconds);
  expect(game.entities.has(trap.id)).toBe(false);
  expect(emittedLights(game)).toHaveLength(0);
});

test("a stunned zombie stands still in sight of a player, and chases it once the stun ends", () => {
  const game = world();
  trapAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  const zombie = zombieAt(game, 400, 300);
  Object.assign(game.local, { x: 550, y: 300, prevX: 550, prevY: 300 });
  run(game, DT * 2);
  expect(isStunned(game, zombie.id)).toBe(true);

  run(game, config.stunSeconds - 0.5);
  expect(zombie.x).toBe(400);
  expect(zombie.y).toBe(300);

  run(game, 0.6);
  expect(isStunned(game, zombie.id)).toBe(false);
  run(game, 0.2);
  expect(zombie.x).toBeGreaterThan(400);
});

test("a player sets off an armed trap, and its flash stuns players whose eyes see it as it does entities", () => {
  const game = world();
  const trap = trapAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  // Facing the trap, down its cone.
  const near = reportedAt(
    game,
    "near",
    { x: 400 + config.stunRange - 20, y: 300 },
    Math.PI,
  );
  // Back turned, the trap well past the small circle it sees all round it.
  const turned = reportedAt(
    game,
    "turned",
    { x: 400, y: 300 + config.stunRange - 20 },
    Math.PI / 2,
  );
  // Behind the pillar at x 200-300, y 50-150, facing the trap.
  const hidden = reportedAt(
    game,
    "hidden",
    { x: 250, y: 30 },
    Math.atan2(270, 150),
  );
  const zombie = face(
    zombieAt(game, 400, 300 - config.stunRange + 30),
    Math.PI / 2,
  );
  // The player that steps on it sees it within the small circle all round it.
  Object.assign(game.local, { x: 400, y: 300, prevX: 400, prevY: 300 });
  run(game, DT * 2);

  expect(TrapState.parse(trap.data).firedAt).not.toBeNull();
  expect(isStunned(game, game.local.id)).toBe(true);
  expect(isStunned(game, near.id)).toBe(true);
  expect(isStunned(game, zombie.id)).toBe(true);
  expect(isStunned(game, turned.id)).toBe(false);
  expect(isStunned(game, hidden.id)).toBe(false);
});

test("a player stunned by a trap stands still whatever it steers, and walks again once the stun ends", () => {
  const game = world();
  trapAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  Object.assign(game.local, { x: 400, y: 300, prevX: 400, prevY: 300 });
  run(game, DT * 2);
  expect(isStunned(game, game.local.id)).toBe(true);

  const walk = { ...idle, move: { x: 0, y: 1 } };
  const steps = (seconds: number) => {
    for (let step = 0; step < Math.round(seconds / DT); step++)
      updateSession(game, walk, DT);
  };
  steps(config.stunSeconds - 0.5);
  expect(game.local.y).toBe(300);
  steps(0.6);
  expect(isStunned(game, game.local.id)).toBe(false);
  steps(0.2);
  expect(game.local.y).toBeGreaterThan(300);
});
