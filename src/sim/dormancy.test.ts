import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { entitySnapshot, registerEntityType, spawnEntity } from "./entities.js";
import type { WorldEntity } from "./entities.js";
import { dealDamage } from "./hurts.js";
import { knockBack } from "./knockback.js";
import type { Session } from "./session.js";
import { createSession, updateSession } from "./session.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

/** Pixels from a player past which a sleepy walker lies dormant. */
const RANGE = 200;

const Steps = z.object({ steps: z.number().int(), restless: z.boolean() });

/**
 * A dev-square session, its player at (600, 450), with a walker that counts its updates and
 * drifts right at 60px/s, dormant past `RANGE` from every player unless restless.
 */
function session(): Session {
  const game = createSession("me", "ME", "SLEEP", "dev", testSfx(), {
    ...testSimConfig,
  });
  Object.assign(game.local, { x: 600, y: 450 });
  registerEntityType(game, "sleepy", {
    radius: 10,
    maxHealth: 10,
    data: Steps,
    dormantBeyond: RANGE,
    wakeful: (_entity, data) => data.restless,
    update(entity, data) {
      entity.vx = 60;
      return { ...data, steps: data.steps + 1 };
    },
    draw: () => undefined,
  });
  return game;
}

function sleepyAt(game: Session, x: number, restless = false): WorldEntity {
  return spawnEntity(game, "sleepy", x, 450, { steps: 0, restless });
}

const steps = (entity: WorldEntity) => Steps.parse(entity.data).steps;

function run(game: Session, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++)
    updateSession(game, idle, DT);
}

test("a kind with a dormant range runs only while a living player stands within it", () => {
  const game = session();
  const near = sleepyAt(game, 600 - RANGE + 20);
  const far = sleepyAt(game, 100);
  run(game, 0.5);
  expect(steps(near)).toBeGreaterThan(0);
  expect(steps(far)).toBe(0);
  expect(far.x).toBe(100);
});

test("a dormant body stirs once a player comes near, going on from where it lay", () => {
  const game = session();
  const far = sleepyAt(game, 100);
  run(game, 0.5);
  Object.assign(game.local, { x: 100 + RANGE - 20 });
  run(game, 0.5);
  expect(steps(far)).toBeGreaterThan(0);
  expect(far.x).toBeGreaterThan(100);
});

test("a wakeful body runs with no player near", () => {
  const game = session();
  const restless = sleepyAt(game, 100, true);
  run(game, 0.5);
  expect(steps(restless)).toBeGreaterThan(0);
});

test("a dormant body can still be hurt, killed and pushed, and is still sent to every client", () => {
  const game = session();
  const far = sleepyAt(game, 100);
  run(game, 0.1);
  knockBack(far, { x: 80, y: 450 }, 30, game.world.map, "stop");
  expect(far.x).toBeCloseTo(130);
  dealDamage(game, far, 4, null);
  expect(far.health).toBe(6);
  run(game, 0.1);
  expect(entitySnapshot(game).map(({ id }) => id)).toContain(far.id);
  dealDamage(game, far, 10, null);
  run(game, 0.1);
  expect(game.entities.has(far.id)).toBe(false);
});
