import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { sentSounds } from "../../integration/sent-sounds.js";
import {
  createSession,
  footprintOf,
  hurtPlayer,
  INERT_TAG,
  mulberry32,
  registerContent,
  registerEntityType,
  spawnEntity,
  stun,
  updateSession,
  viewOf,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshSleeper, sleeper as sleeperContent } from "../sleeper/index.js";
import {
  freshZombie,
  zombie as zombieContent,
  ZombieState,
} from "../zombie/index.js";
import { freshStatue, statue as statueContent, StatueState } from "./index.js";
import type { StatueConfig } from "./index.js";

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
const { statue: config } = testEntitiesConfig;
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

/** The dev square, all of it dark, with the statue; the player stands at (x, y). */
function world(x: number, y: number, statue: StatueConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "STATUE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    statueContent.create({ statue }),
    zombieContent.create(testEntitiesConfig),
    sleeperContent.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  sent.set(game, []);
  return game;
}

const played = (game: Session): string[] => sent.get(game) ?? [];

/** Steps `seconds`, one step a frame, the player aiming at `aim`, noting each sound sent. */
function run(game: Session, seconds: number, aim: Point = idle.aim): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, { ...idle, aim }, DT);
    for (const { payload } of game.outbox.splice(0)) {
      played(game).push(...sentSounds(payload));
    }
  }
}

function statueAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "statue", x, y, freshStatue(game.worldTime));
}

const stateOf = (statue: WorldEntity) => StatueState.parse(statue.data);

/** A statue that sees only right round it, so it keeps to its round. */
const nearSighted: StatueConfig = { ...config, sightRange: 50 };

test("unseen and seeing no one, it walks its round at a sprint, its tread heard", () => {
  const game = world(100, 550, nearSighted);
  const statue = statueAt(game, 700, 300);
  run(game, 0.5);
  const { mode, far, home } = stateOf(statue);
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
  expect(Math.hypot(statue.vx, statue.vy)).toBeCloseTo(SPRINT);
  expect(played(game)).toContain("step.mp3");
});

test("looked at, it cannot move nor strike, and its hunt's clock stops; looked away from, it runs the player down", () => {
  const game = world(300, 300);
  const statue = statueAt(game, 500, 300);
  run(game, 0.5, { x: 500, y: 300 });
  expect(stateOf(statue)).toMatchObject({ mode: "hunt", frozen: true });
  expect(statue.x).toBe(500);
  const left = stateOf(statue).huntUntil - game.worldTime;
  run(game, 1, { x: 500, y: 300 });
  expect(statue.x).toBe(500);
  expect(stateOf(statue).huntUntil - game.worldTime).toBeCloseTo(left, 1);

  run(game, 1, { x: 0, y: 300 });
  expect(stateOf(statue).frozen).toBe(false);
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
  expect(played(game)).toContain("strike.mp3");
});

test("being close, within the circle a player sees all round them, does not hold it", () => {
  const game = world(300, 300);
  const statue = statueAt(game, 330, 300);
  run(game, 0.2, { x: 0, y: 300 });
  expect(stateOf(statue).frozen).toBe(false);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
});

test("a dead player's eyes do not hold it", () => {
  const game = world(300, 300);
  const statue = statueAt(game, 600, 300);
  hurtPlayer(game, game.local, game.local.maxHealth);
  run(game, 0.5, { x: 600, y: 300 });
  expect(stateOf(statue).frozen).toBe(false);
  expect(statue.x).not.toBe(600);
});

test("once its hunt has run its time, it goes back to its round", () => {
  const game = world(100, 550, nearSighted);
  const statue = statueAt(game, 700, 300);
  statue.data = {
    ...stateOf(statue),
    mode: "hunt",
    quarry: "me",
    huntUntil: game.worldTime + 0.5,
  };
  run(game, 0.3);
  expect(stateOf(statue).mode).toBe("hunt");
  expect(statue.vx).toBeLessThan(0);
  run(game, 0.3);
  expect(stateOf(statue)).toMatchObject({ mode: "patrol", quarry: null });
});

test("a player looking at it from past their look range does not hold it", () => {
  const far = 100 + testSimConfig.vision.lookRange + 100;
  const game = world(100, 300, nearSighted);
  const statue = statueAt(game, far, 300);
  run(game, 0.5, { x: 2000, y: 300 });
  expect(stateOf(statue).frozen).toBe(false);
  expect(statue.x).not.toBe(far);
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
  const statue = statueAt(game, 650, 300);
  const zombie = zombieAt(game, 500, 300, 0);
  run(game, 0.5);
  expect(stateOf(statue).frozen).toBe(true);
  expect(statue.x).toBe(650);
  expect(ZombieState.parse(zombie.data).facing).toBeCloseTo(0, 1);
});

test("a stunned zombie's gaze does not hold it", () => {
  const game = world(100, 550, nearSighted);
  const statue = statueAt(game, 650, 300);
  const zombie = zombieAt(game, 500, 300, 0);
  stun(game, zombie.id, 10);
  run(game, 0.5);
  expect(stateOf(statue).frozen).toBe(false);
  expect(statue.x).not.toBe(650);
});

test("a body that sees it only all round, as a sleeping sleeper does, does not hold it", () => {
  const game = world(100, 550, nearSighted);
  const statue = statueAt(game, 650, 300);
  const fresh = freshSleeper(game.worldTime, testEntitiesConfig.sleeper);
  spawnEntity(game, "sleeper", 620, 300, fresh);
  run(game, 0.5);
  expect(stateOf(statue).frozen).toBe(false);
  expect(statue.x).not.toBe(650);
});

test("it cannot die", () => {
  const game = world(100, 550, nearSighted);
  const statue = statueAt(game, 700, 300);
  statue.health -= 1e9;
  run(game, 0.1);
  expect(game.entities.has(statue.id)).toBe(true);
});

/** A post at (x, y): a body with no eyes nor will of its own, neither player nor monster. */
function postAt(game: Session, x: number, y: number): WorldEntity {
  if (!game.kindIds.has("post"))
    registerEntityType(game, "post", {
      radius: 10,
      maxHealth: 1000,
      data: z.object({}),
      draw: () => undefined,
    });
  return spawnEntity(game, "post", x, y, {});
}

test("it hunts only the kinds it targets: a player, not a nearer body it sees", () => {
  const game = world(100, 550);
  const statue = statueAt(game, 650, 300);
  postAt(game, 400, 300);
  run(game, 0.1);
  expect(stateOf(statue)).toMatchObject({
    mode: "hunt",
    quarry: game.localId,
  });
});

test("seeing only bodies of kinds it does not target, it keeps to its round", () => {
  const game = world(100, 550);
  hurtPlayer(game, game.local, Infinity);
  const statue = statueAt(game, 650, 300);
  postAt(game, 400, 300);
  run(game, 0.5);
  expect(stateOf(statue).mode).toBe("patrol");
});

test("with no targets it hunts any body it sees, not just players, and strikes it", () => {
  const anyBody: StatueConfig = { ...config };
  Reflect.deleteProperty(anyBody, "targets");
  const game = world(100, 550, anyBody);
  hurtPlayer(game, game.local, Infinity);
  const statue = statueAt(game, 650, 300);
  const post = postAt(game, 400, 300);
  run(game, 0.1);
  expect(stateOf(statue)).toMatchObject({ mode: "hunt", quarry: post.id });
  run(game, 1);
  expect(post.health).toBe(1000 - config.damage);
});

test("a kind it ignores it neither hunts nor strikes", () => {
  const game = world(100, 550, { ...config, ignores: ["statue", "post"] });
  hurtPlayer(game, game.local, Infinity);
  const statue = statueAt(game, 650, 300);
  const post = postAt(game, 630, 300);
  run(game, 1);
  expect(stateOf(statue).mode).toBe("patrol");
  expect(post.health).toBe(1000);
});

/** A lamp at `at`, lighting `range` round it: a body with no will that only gives off light. */
function lampAt(game: Session, at: Point, range: number): WorldEntity {
  if (!game.kindIds.has("lamp"))
    registerEntityType(game, "lamp", {
      radius: 5,
      maxHealth: 1,
      tags: [INERT_TAG],
      collides: false,
      data: z.object({}),
      light: () => ({ range }),
      draw: () => undefined,
    });
  return spawnEntity(game, "lamp", at.x, at.y, {});
}

test("lit past where its player looks, in plain view on their screen, it is held", () => {
  const at = { x: 100 + testSimConfig.vision.lookRange + 100, y: 300 };
  const game = world(100, 300, nearSighted);
  lampAt(game, { x: at.x + 40, y: at.y }, 200);
  const statue = statueAt(game, at.x, at.y);
  run(game, 0.5, { x: 2000, y: 300 });
  expect(viewOf(game, game.local).shows(footprintOf(game, statue))).toBe(true);
  expect(stateOf(statue).frozen).toBe(true);
  expect(statue.x).toBe(at.x);
});

test("an edge of it in view holds it, though its middle is out of the cone", () => {
  const game = world(300, 300, nearSighted);
  // Its middle just past the cone's edge: 45 degrees off the aim, the watch margin's 10 more and
  // a little over.
  const off = Math.PI / 4 + Math.PI / 18 + 0.05;
  const at = { x: 300 + Math.cos(off) * 150, y: 300 + Math.sin(off) * 150 };
  lampAt(game, { x: 300, y: 300 }, 400);
  const statue = statueAt(game, at.x, at.y);
  run(game, 0.3, { x: 2000, y: 300 });
  expect(stateOf(statue).frozen).toBe(true);
  expect(statue.x).toBe(at.x);
});

test("wherever its player's screen draws it, but in the small circle round them, it never moves", () => {
  const { surroundingsRadius } = testSimConfig.vision;
  const aim = { x: 2000, y: 300 };
  let drawn = 0;
  let hidden = 0;
  for (let distance = 100; distance <= 600; distance += 100)
    for (let turn = 0; turn < 24; turn++) {
      const angle = (turn / 24) * Math.PI * 2;
      const game = world(500, 300, nearSighted);
      lampAt(game, { x: 500, y: 300 }, 450);
      const x = 500 + Math.cos(angle) * distance;
      const y = 300 + Math.sin(angle) * distance;
      const statue = statueAt(game, x, y);
      run(game, DT, aim);
      const shows = viewOf(game, game.local).shows(footprintOf(game, statue));
      const near =
        Math.hypot(x - 500, y - 300) <= surroundingsRadius + statue.radius;
      if (!shows || near) {
        hidden++;
        continue;
      }
      drawn++;
      run(game, 0.2, aim);
      expect(stateOf(statue).frozen, `at ${String(x)}, ${String(y)}`).toBe(
        true,
      );
      expect(
        { x: statue.x, y: statue.y },
        `at ${String(x)}, ${String(y)}`,
      ).toEqual({ x, y });
    }
  // Both kinds of spot came up, so the test sampled something.
  expect(drawn).toBeGreaterThan(5);
  expect(hidden).toBeGreaterThan(5);
});
