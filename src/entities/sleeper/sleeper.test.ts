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
  hurt,
  hurtPlayer,
  makeNoise,
  mulberry32,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type {
  Point,
  Session,
  WorldContent,
  WorldEntity,
} from "../../sim/index.js";
import {
  freshSleeper,
  sleeper as sleeperContent,
  SleeperState,
} from "./index.js";
import type { SleeperConfig } from "./index.js";

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
const { sleeper: config } = testEntitiesConfig;

// Her wander legs and hideouts draw from Math.random; seeded so each run is the same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(5));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The sounds each session's host has sent, by the last part of their urls. */
const sent = new WeakMap<Session, string[]>();

/** Noises each session makes in its next step, each carrying `radius` from `at`. */
const pending = new WeakMap<Session, { at: Point; radius: number }[]>();

/** Makes, in `game`'s next step, a noise from `at` carrying `radius`, made by no one in it. */
function noise(game: Session, at: Point, radius: number): void {
  pending.get(game)?.push({ at, radius });
}

const noiser: WorldContent = {
  name: "move/noiser",
  register: () => undefined,
  populate: () => undefined,
  act(game) {
    for (const made of (pending.get(game) ?? []).splice(0))
      makeNoise(game, { id: "somewhere" }, made);
  },
};

/** The dev square, all of it dark, with the sleeper; the player stands at (x, y). */
function world(x: number, y: number, sleeper: SleeperConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "SLEEPER",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [sleeperContent.create({ sleeper }), noiser]);
  pending.set(game, []);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  sent.set(game, []);
  return game;
}

const played = (game: Session): string[] => sent.get(game) ?? [];

/** Steps `seconds`, one step a frame, noting each sound the host sends. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    for (const { payload } of game.outbox.splice(0)) {
      played(game).push(...sentSounds(payload));
    }
  }
}

function sleeperAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(
    game,
    "sleeper",
    x,
    y,
    freshSleeper(game.worldTime, config),
  );
}

const stateOf = (sleeper: WorldEntity) => SleeperState.parse(sleeper.data);

test("a dormant sleeper with no one near sits still and barks now and then", () => {
  const game = world(100, 300);
  const sleeper = sleeperAt(game, 700, 300);
  run(game, config.barkGap.dormant.max + 0.1);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(sleeper.x).toBe(700);
  expect(played(game)).toContain("bark.mp3");
});

test("a player close by makes her growl, and if still there a second later she wakes and runs them down", () => {
  const game = world(450, 300);
  const sleeper = sleeperAt(game, 650, 300);
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("warning");
  expect(played(game)).toContain("growl.mp3");
  run(game, config.warnSeconds);
  expect(stateOf(sleeper).mode).toBe("enraged");
  expect(played(game)).toContain("enrage.mp3");
  run(game, 1);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
  expect(played(game)).toContain("attack.wav");
});

test("a player who backs off before her growl ends leaves her dormant", () => {
  const game = world(450, 300);
  const sleeper = sleeperAt(game, 650, 300);
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("warning");
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  run(game, config.warnSeconds);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(sleeper.x).toBe(650);
});

test("light on her wakes her enraged, however far the players", () => {
  const game = world(100, 300);
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({ range: 100 }),
    draw: () => undefined,
  });
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 0.5);
  expect(stateOf(sleeper).mode).toBe("dormant");
  spawnEntity(game, "lamp", 760, 300, {});
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("enraged");
});

test("hurt by a player while dormant, she wakes and runs them down", () => {
  const game = world(100, 300);
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 0.1);
  hurt(game, sleeper, 15, game.localId);
  run(game, 0.2);
  expect(stateOf(sleeper).mode).toBe("enraged");
  expect(stateOf(sleeper).foe).toBe(game.localId);
  expect(stateOf(sleeper).target).toMatchObject({ x: 100, y: 300 });
  expect(sleeper.vx).toBeLessThan(0);
});

test("hurt by any body, she goes for it rather than the player she sees", () => {
  const game = world(500, 300);
  registerEntityType(game, "post", {
    radius: 10,
    maxHealth: 10,
    data: z.object({}),
    draw: () => undefined,
  });
  const sleeper = sleeperAt(game, 700, 300);
  const post = spawnEntity(game, "post", 850, 450, {});
  run(game, 0.1);
  hurt(game, sleeper, 15, post.id);
  run(game, 0.2);
  expect(stateOf(sleeper).mode).toBe("enraged");
  expect(stateOf(sleeper).foe).toBe(post.id);
  expect(stateOf(sleeper).target).toMatchObject({ x: 850, y: 450 });
  expect(sleeper.vx).toBeGreaterThan(0);
});

test("once her rage runs out she runs for a dark spot away from the players and sleeps there", () => {
  const game = world(100, 300);
  const sleeper = sleeperAt(game, 700, 300);
  const state = stateOf(sleeper);
  sleeper.data = {
    ...state,
    mode: "enraged",
    until: game.worldTime + 0.5,
  };
  run(game, 0.6);
  expect(stateOf(sleeper).mode).toBe("retreat");
  const speed =
    testSimConfig.player.speed *
    testSimConfig.player.sprintMultiplier *
    config.runShare;
  expect(Math.hypot(sleeper.vx, sleeper.vy)).toBeCloseTo(speed);
  run(game, 4);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(
    Math.hypot(sleeper.x - game.local.x, sleeper.y - game.local.y),
  ).toBeGreaterThan(config.retreat.clearance - sleeper.radius);
});

test("once she kills, she retreats at once", () => {
  const game = world(450, 300, { ...config, attackDamage: 1000 });
  const sleeper = sleeperAt(game, 650, 300);
  run(game, config.warnSeconds + 1.5);
  expect(game.local.health).toBe(0);
  expect(["retreat", "dormant"]).toContain(stateOf(sleeper).mode);
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

test("any body close by wakes her as a player does, and she runs it down", () => {
  const game = world(100, 300);
  hurtPlayer(game, game.local, Infinity);
  const sleeper = sleeperAt(game, 650, 300);
  const post = postAt(game, 500, 300);
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("warning");
  run(game, config.warnSeconds);
  expect(stateOf(sleeper).mode).toBe("enraged");
  run(game, 1);
  expect(post.health).toBeLessThan(1000);
});

test("a kind she ignores does not wake her", () => {
  const game = world(100, 300, { ...config, ignores: ["sleeper", "post"] });
  hurtPlayer(game, game.local, Infinity);
  const sleeper = sleeperAt(game, 650, 300);
  postAt(game, 500, 300);
  run(game, config.warnSeconds + 0.5);
  expect(stateOf(sleeper).mode).toBe("dormant");
});

test("she sleeps again away from every body she hunts, not just the players", () => {
  const game = world(100, 550);
  const sleeper = sleeperAt(game, 450, 300);
  const post = postAt(game, 450, 450);
  sleeper.data = {
    ...stateOf(sleeper),
    mode: "enraged",
    until: game.worldTime,
  };
  run(game, 4);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(Math.hypot(sleeper.x - post.x, sleeper.y - post.y)).toBeGreaterThan(
    config.retreat.clearance - sleeper.radius,
  );
});

test("a noise that carries her alarm radius wakes her screaming, and she runs at it", () => {
  const game = world(100, 550);
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 0.1);
  noise(game, { x: 700, y: 650 }, config.alarmRadius);
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("enraged");
  expect(played(game)).toContain("enrage.mp3");
  expect(stateOf(sleeper).target?.y).toBeGreaterThan(550);
  expect(sleeper.vy).toBeGreaterThan(0);
});

test("a noise short of her alarm radius, however close, leaves her asleep", () => {
  const game = world(100, 550);
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 0.1);
  noise(game, { x: 700, y: 400 }, config.alarmRadius - 1);
  run(game, 0.5);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(played(game)).not.toContain("enrage.mp3");
});

test("a big noise turns her back from her retreat", () => {
  const game = world(100, 550);
  const sleeper = sleeperAt(game, 700, 300);
  sleeper.data = {
    ...stateOf(sleeper),
    mode: "enraged",
    until: game.worldTime,
  };
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("retreat");
  noise(game, { x: 300, y: 300 }, config.alarmRadius);
  run(game, 0.1);
  expect(stateOf(sleeper).mode).toBe("enraged");
});

/** Leaves her place after 2s with no body within 200px, never within 300px of a player. */
const restless: SleeperConfig = {
  ...config,
  spawning: { ...config.spawning, unseenDistance: 300 },
  relocate: { after: 2, range: 200, retry: 1 },
};

test("asleep long enough with no body near, she moves unseen to somewhere she might have arrived", () => {
  const game = world(100, 550, restless);
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 1.5);
  expect(sleeper).toMatchObject({ x: 700, y: 300 });
  run(game, 1);
  expect(stateOf(sleeper).mode).toBe("dormant");
  expect(sleeper.x !== 700 || sleeper.y !== 300).toBe(true);
  expect(
    Math.hypot(sleeper.x - game.local.x, sleeper.y - game.local.y),
  ).toBeGreaterThanOrEqual(restless.spawning.unseenDistance);
  expect(played(game).filter((url) => url === "vanish.mp3")).toHaveLength(2);
});

test("any body near keeps her where she is, a player or not", () => {
  const game = world(100, 550, { ...restless, wakeRange: 100 });
  hurtPlayer(game, game.local, Infinity);
  const sleeper = sleeperAt(game, 700, 300);
  postAt(game, 700, 450);
  run(game, 3);
  expect(sleeper).toMatchObject({ x: 700, y: 300 });
});

test("she does not leave while a player stands near enough to watch her go", () => {
  const game = world(450, 300, { ...restless, wakeRange: 100 });
  const sleeper = sleeperAt(game, 700, 300);
  run(game, 3);
  expect(sleeper).toMatchObject({ x: 700, y: 300 });
  expect(played(game)).not.toContain("vanish.mp3");
});
