import { expect, test } from "vitest";
import { z } from "zod";
import { reportedAt } from "../../integration/heard.js";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  isStunned,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { placeTurret, turret, TurretState } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};
const config = testEntitiesConfig.turret;
const zombieHealth = testEntitiesConfig.zombie.maxHealth;

/**
 * The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550, with zombies and
 * turrets; the player stands by its bottom-left corner, out of the way of every shot.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "TURRET",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    turret.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x: 40, y: 560, prevX: 40, prevY: 560 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

/** A zombie at `x`, `y`, stunned long enough to stand there for the whole test. */
function zombieAt(game: Session, x: number, y: number): WorldEntity {
  const zombie = spawnEntity(
    game,
    "zombie",
    x,
    y,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  stun(game, zombie.id, 60);
  return zombie;
}

/** A turret at `x`, `y`, facing `facing`, just put down. */
function turretAt(game: Session, x: number, y: number, facing = 0) {
  return spawnEntity(game, "turret", x, y, {
    since: game.worldTime,
    armed: false,
    facing,
    turnedAt: game.worldTime,
    target: null,
    shotAt: game.worldTime,
    fired: 0,
  });
}

const stateOf = (entity: WorldEntity) => TurretState.parse(entity.data);

test("a turret sets up over its arming time, seeing nothing until it has", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  const zombie = zombieAt(game, 550, 300);
  run(game, config.armSeconds - 0.2);
  expect(stateOf(self)).toMatchObject({ armed: false, target: null });

  run(game, 0.3);
  expect(stateOf(self)).toMatchObject({ armed: true, target: zombie.id });
});

test("it locks on a monster in its beam and shoots it a handgun's shot every interval", () => {
  const game = world();
  turretAt(game, 400, 300);
  const zombie = zombieAt(game, 550, 300);
  run(game, config.armSeconds + 0.1);
  expect(zombie.health).toBe(zombieHealth);

  run(game, config.shot.aimSeconds);
  expect(zombie.health).toBe(zombieHealth - config.shot.damage);

  run(game, config.shot.interval - 0.2);
  expect(zombie.health).toBe(zombieHealth - config.shot.damage);
  run(game, 0.3);
  expect(game.entities.has(zombie.id)).toBe(false);
});

test("it sweeps round to a monster behind it, once a turn", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  // Behind it, half a turn round.
  const zombie = zombieAt(game, 250, 300);
  run(game, config.armSeconds + 0.1);
  expect(stateOf(self).target).toBeNull();

  run(game, config.turnSeconds / 2);
  expect(stateOf(self).target).toBe(zombie.id);
});

test("it never locks on a player, nor shoots one in its beam", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  const player = reportedAt(game, "them", { x: 550, y: 300 }, Math.PI);
  run(game, config.armSeconds + config.turnSeconds + 0.5);
  expect(stateOf(self).target).toBeNull();
  expect(player.health).toBe(player.maxHealth);
});

test("it sweeps again from where it faces once its target is gone", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  const zombie = zombieAt(game, 550, 300);
  run(game, config.armSeconds + 0.1);
  expect(stateOf(self).target).toBe(zombie.id);

  game.entities.delete(zombie.id);
  run(game, DT);
  expect(stateOf(self)).toMatchObject({ target: null, facing: 0 });
  const swept = stateOf(self).turnedAt;
  run(game, 0.5);
  expect(stateOf(self).turnedAt).toBe(swept);
});

test("it loses a target that goes behind a wall", () => {
  const game = world();
  const self = turretAt(game, 250, 300, -Math.PI / 2);
  // Straight up, clear of the pillar at x 200-300, y 50-150.
  const zombie = zombieAt(game, 250, 180);
  run(game, config.armSeconds + 0.1);
  expect(stateOf(self).target).toBe(zombie.id);

  // Behind the pillar.
  Object.assign(zombie, { y: 20, prevY: 20, ty: 20 });
  run(game, DT);
  expect(stateOf(self).target).toBeNull();
});

test("stunned, it holds its fire until the stun ends", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  const zombie = zombieAt(game, 550, 300);
  run(game, config.armSeconds + 0.1);
  stun(game, self.id, 2);
  run(game, 1.9);
  expect(isStunned(game, self.id)).toBe(true);
  expect(zombie.health).toBe(zombieHealth);

  run(game, 0.2);
  expect(zombie.health).toBe(zombieHealth - config.shot.damage);
});

test("a stunned turret sees nothing new", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  stun(game, self.id, config.turnSeconds * 2);
  zombieAt(game, 550, 300);
  run(game, config.turnSeconds * 1.5);
  expect(stateOf(self).target).toBeNull();
});

test("worn down, it breaks", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  run(game, config.armSeconds + 0.1);
  hurt(game, self, config.maxHealth, null);
  run(game, DT * 2);
  expect(game.entities.has(self.id)).toBe(false);
});

const Sent = z.object({ effects: z.array(z.object({ sound: z.string() })) });

/** The names of the sounds the host has sent since last asked, emptying its outbox. */
function sent(game: Session): string[] {
  return game.outbox.splice(0).flatMap(({ payload }) => {
    const parsed = Sent.safeParse(payload);
    if (!parsed.success) return [];
    return parsed.data.effects.map(
      ({ sound }) => sound.split("/").at(-1) ?? sound,
    );
  });
}

test("it holds its config's ammo, and once spent it clicks dry where it would shoot", () => {
  const game = world();
  const self = turretAt(game, 400, 300);
  self.data = { ...stateOf(self), fired: config.ammo - 1 };
  const zombie = zombieAt(game, 550, 300);
  run(game, config.armSeconds + 0.1 + config.shot.aimSeconds);
  expect(zombie.health).toBe(zombieHealth - config.shot.damage);
  expect(stateOf(self).fired).toBe(config.ammo);

  sent(game);
  run(game, config.shot.interval);
  expect(zombie.health).toBe(zombieHealth - config.shot.damage);
  expect(stateOf(self)).toMatchObject({
    target: zombie.id,
    fired: config.ammo,
  });
  expect(sent(game)).toContain("click.mp3");
});

test("a turret put down has fired nothing yet, and fires its config's ammo before it runs dry", () => {
  const game = world();
  placeTurret(game, game.local, 0);
  const self = [...game.entities.values()].at(-1);
  if (self === undefined) throw new Error("No turret was put down");
  expect(stateOf(self).fired).toBe(0);
  // A fresh zombie every shot, each standing in its beam.
  run(game, config.armSeconds + 0.1);
  for (let shot = 0; shot < config.ammo + 2; shot++) {
    const zombie = zombieAt(game, self.x + 150, self.y);
    zombie.health = Infinity;
    run(game, config.shot.aimSeconds + config.shot.interval);
    game.entities.delete(zombie.id);
    run(game, DT);
  }
  expect(stateOf(self).fired).toBe(config.ammo);
});
