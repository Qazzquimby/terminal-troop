import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import type { Session } from "./session.js";
import { createSession, updateSession } from "./session.js";
import { entityStatuses, isStunned, stun } from "./status.js";
import { applyWorldEntries, takeWorldEntries } from "./world-data.js";

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

/** A dev-square session whose one kind counts its updates and walks right at 60px/s. */
function session(localId = "me"): Session {
  const game = createSession(
    localId,
    "ME",
    "STUN",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 600, y: 450 });
  registerEntityType(game, "walker", {
    radius: 10,
    maxHealth: 10,
    data: z.object({ steps: z.number().int() }),
    update(entity, data) {
      entity.vx = 60;
      return { steps: data.steps + 1 };
    },
    strikes: () => [{ target: "me", amount: 1 }],
    draw: () => undefined,
  });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

test("a stunned entity of any kind neither runs, moves nor strikes until the stun ends", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  const health = game.local.health;
  expect(stun(game, walker.id, 1)).toBe(true);

  run(game, 0.5);
  expect(isStunned(game, walker.id)).toBe(true);
  expect(walker.data).toEqual({ steps: 0 });
  expect(walker.x).toBe(100);
  expect(game.local.health).toBe(health);

  run(game, 0.6);
  expect(isStunned(game, walker.id)).toBe(false);
  expect(
    z.object({ steps: z.number() }).parse(walker.data).steps,
  ).toBeGreaterThan(0);
  expect(walker.x).toBeGreaterThan(100);
  expect(game.local.health).toBeLessThan(health);
});

test("stunning again lengthens a stun but never shortens it", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  stun(game, walker.id, 2);
  stun(game, walker.id, 1);
  run(game, 1.5);
  expect(isStunned(game, walker.id)).toBe(true);
  stun(game, walker.id, 1);
  run(game, 0.8);
  expect(isStunned(game, walker.id)).toBe(true);
  run(game, 0.3);
  expect(isStunned(game, walker.id)).toBe(false);
});

test("ended stuns, and those of entities gone, are forgotten", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  const other = spawnEntity(game, "walker", 300, 100, { steps: 0 });
  stun(game, walker.id, 0.1);
  stun(game, other.id, 10);
  game.entities.delete(other.id);
  run(game, 0.2);
  expect(entityStatuses.get(game)).toEqual({});
});

test("only the host stuns, and every client holds who is stunned", () => {
  const host = session("me");
  const guest = session("you");
  guest.hosting = false;
  const walker = spawnEntity(host, "walker", 100, 100, { steps: 0 });
  spawnEntity(guest, "walker", 100, 100, { steps: 0 });

  expect(stun(guest, walker.id, 5)).toBe(false);
  expect(stun(host, walker.id, 5)).toBe(true);
  const entries = takeWorldEntries(host, false);
  expect(entries).not.toBeNull();
  applyWorldEntries(guest, { host: "me", term: 1 }, entries ?? {});
  expect(isStunned(guest, walker.id)).toBe(true);
});
