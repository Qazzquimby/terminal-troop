import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurtPlayer,
  mulberry32,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshWitch, witch as witchContent } from "../witch/index.js";
import {
  freshZombie,
  zombie as zombieContent,
  ZombieState,
} from "../zombie/index.js";
import { freshIdol, idol as idolContent, IdolState } from "./index.js";
import type { IdolConfig } from "./index.js";

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
const { idol: config } = testEntitiesConfig;
const SPRINT =
  testSimConfig.player.speed * testSimConfig.player.sprintMultiplier;

// Its round's far end draws from Math.random; seeded so each run is the same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(9));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The sounds each session's host has sent, by the last part of their urls. */
const sent = new WeakMap<Session, string[]>();

/** The dev square, all of it dark, with the idol; the player stands at (x, y). */
function world(x: number, y: number, idol: IdolConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "IDOL",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    idolContent.create({ idol }),
    zombieContent.create(testEntitiesConfig),
    witchContent.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  sent.set(game, []);
  return game;
}

const played = (game: Session): string[] => sent.get(game) ?? [];

const Sent = z.object({ effects: z.array(z.object({ sound: z.string() })) });

/** Steps `seconds`, one step a frame, the player aiming at `aim`, noting each sound sent. */
function run(game: Session, seconds: number, aim: Point = idle.aim): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, { ...idle, aim }, DT);
    for (const { payload } of game.outbox.splice(0)) {
      const parsed = Sent.safeParse(payload);
      if (!parsed.success) continue;
      for (const { sound } of parsed.data.effects)
        played(game).push(sound.split("/").at(-1) ?? sound);
    }
  }
}

function idolAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "idol", x, y, freshIdol(game.worldTime));
}

const stateOf = (idol: WorldEntity) => IdolState.parse(idol.data);

/** An idol that sees only right round it, so it keeps to its round. */
const nearSighted: IdolConfig = { ...config, sightRange: 50 };

test("unseen and seeing no one, it walks its round at a sprint, its tread heard", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 700, 300);
  run(game, 0.5);
  const { mode, far, home } = stateOf(idol);
  expect(mode).toBe("patrol");
  expect(far).not.toBeNull();
  expect(home).toEqual({ x: 700, y: 300 });
  const reach = Math.hypot((far?.x ?? 0) - 700, (far?.y ?? 0) - 300);
  expect(reach).toBeGreaterThanOrEqual(
    config.patrol.distance - config.patrol.spread,
  );
  expect(reach).toBeLessThanOrEqual(
    config.patrol.distance + config.patrol.spread,
  );
  expect(Math.hypot(idol.vx, idol.vy)).toBeCloseTo(SPRINT);
  expect(played(game)).toContain("step.mp3");
});

test("looked at, it cannot move nor strike, and its hunt's clock stops; looked away from, it runs the player down", () => {
  const game = world(300, 300);
  const idol = idolAt(game, 500, 300);
  run(game, 0.5, { x: 500, y: 300 });
  expect(stateOf(idol)).toMatchObject({ mode: "hunt", frozen: true });
  expect(idol.x).toBe(500);
  const left = stateOf(idol).huntUntil - game.worldTime;
  run(game, 1, { x: 500, y: 300 });
  expect(idol.x).toBe(500);
  expect(stateOf(idol).huntUntil - game.worldTime).toBeCloseTo(left, 1);

  run(game, 1, { x: 0, y: 300 });
  expect(stateOf(idol).frozen).toBe(false);
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
  expect(played(game)).toContain("strike.mp3");
});

test("being close, within the circle a player sees all round them, does not hold it", () => {
  const game = world(300, 300);
  const idol = idolAt(game, 330, 300);
  run(game, 0.2, { x: 0, y: 300 });
  expect(stateOf(idol).frozen).toBe(false);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
});

test("a dead player's eyes do not hold it", () => {
  const game = world(300, 300);
  const idol = idolAt(game, 600, 300);
  hurtPlayer(game, game.local, game.local.maxHealth);
  run(game, 0.5, { x: 600, y: 300 });
  expect(stateOf(idol).frozen).toBe(false);
  expect(idol.x).not.toBe(600);
});

test("once its hunt has run its time, it goes back to its round", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 700, 300);
  idol.data = {
    ...stateOf(idol),
    mode: "hunt",
    quarry: "me",
    huntUntil: game.worldTime + 0.5,
  };
  run(game, 0.3);
  expect(stateOf(idol).mode).toBe("hunt");
  expect(idol.vx).toBeLessThan(0);
  run(game, 0.3);
  expect(stateOf(idol)).toMatchObject({ mode: "patrol", quarry: null });
});

test("a player looking at it from past their look range does not hold it", () => {
  const far = 100 + testSimConfig.vision.lookRange + 100;
  const game = world(100, 300, nearSighted);
  const idol = idolAt(game, far, 300);
  run(game, 0.5, { x: 2000, y: 300 });
  expect(stateOf(idol).frozen).toBe(false);
  expect(idol.x).not.toBe(far);
});

/** A zombie at (x, y), facing `facing`. */
function zombieAt(
  game: Session,
  x: number,
  y: number,
  facing: number,
): WorldEntity {
  const fresh = freshZombie(1, game.worldTime, testEntitiesConfig.zombie);
  return spawnEntity(game, "zombie", x, y, { ...fresh, facing });
}

test("a zombie looking at it holds it, as a player's gaze does", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 650, 300);
  const zombie = zombieAt(game, 500, 300, 0);
  run(game, 0.5);
  expect(stateOf(idol).frozen).toBe(true);
  expect(idol.x).toBe(650);
  expect(ZombieState.parse(zombie.data).facing).toBeCloseTo(0, 1);
});

test("a stunned zombie's gaze does not hold it", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 650, 300);
  const zombie = zombieAt(game, 500, 300, 0);
  stun(game, zombie.id, 10);
  run(game, 0.5);
  expect(stateOf(idol).frozen).toBe(false);
  expect(idol.x).not.toBe(650);
});

test("a body that sees it only all round, as a sleeping witch does, does not hold it", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 650, 300);
  const fresh = freshWitch(game.worldTime, testEntitiesConfig.witch);
  spawnEntity(game, "witch", 620, 300, fresh);
  run(game, 0.5);
  expect(stateOf(idol).frozen).toBe(false);
  expect(idol.x).not.toBe(650);
});

test("it cannot die", () => {
  const game = world(100, 550, nearSighted);
  const idol = idolAt(game, 700, 300);
  idol.health -= 1e9;
  run(game, 0.1);
  expect(game.entities.has(idol.id)).toBe(true);
});
