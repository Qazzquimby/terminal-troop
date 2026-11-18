import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  aimAt,
  createSession,
  eyesOf,
  hurt,
  mulberry32,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshPeeper, peeper as peeperContent, PeeperState } from "./index.js";
import type { PeeperConfig } from "./index.js";

const DT = 1 / 60;
const { peeper: config } = testEntitiesConfig;

// Where it relocates to draws from Math.random; seeded so each run is the same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(5));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The sounds each session's host has sent, by the last part of their urls. */
const sent = new WeakMap<Session, string[]>();

const played = (game: Session): string[] => sent.get(game) ?? [];

const Sent = z.object({ effects: z.array(z.object({ sound: z.string() })) });

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, all dark, with the peeper and a watcher kind: a body whose view cone,
 * a quarter turn wide and 300px long, faces right. The player stands at (x, y).
 */
function world(x: number, y: number, peeper: PeeperConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "PEEPER",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [peeperContent.create({ peeper })]);
  registerEntityType(game, "watcher", {
    radius: 10,
    maxHealth: 100,
    data: z.object({}),
    eyes: () => ({
      cone: { direction: 0, angle: Math.PI / 2, range: 300 },
      around: 0,
    }),
    draw: () => undefined,
  });
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  sent.set(game, []);
  return game;
}

/** Steps `seconds`, the player's mouse held over `look`, noting each sound the host sends. */
function run(game: Session, seconds: number, look: Point): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim: look,
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
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    for (const { payload } of game.outbox.splice(0)) {
      const parsed = Sent.safeParse(payload);
      if (!parsed.success) continue;
      for (const { sound } of parsed.data.effects)
        played(game).push(sound.split("/").at(-1) ?? sound);
    }
  }
}

const peeperAt = (game: Session, x: number, y: number): WorldEntity =>
  spawnEntity(game, "peeper", x, y, freshPeeper(game.worldTime));

const stateOf = (entity: WorldEntity): PeeperState =>
  PeeperState.parse(entity.data);

/** How far apart two facings are, in radians, the short way round. */
const turn = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test("it drags a player's aim onto it from behind, as if the mouse were held over it", () => {
  const game = world(450, 300);
  const peeper = peeperAt(game, 650, 300);
  // The mouse is held off to the left, the peeper behind the player.
  const left = { x: 100, y: 300 };
  run(game, DT, left);
  expect(turn(game.local.aim, Math.PI)).toBeLessThan(0.1);
  run(game, config.pullSeconds + 0.1, left);
  expect(turn(game.local.aim, aimAt(game.local, peeper))).toBeLessThan(1e-6);
  expect(stateOf(peeper).held).toEqual(["me"]);
});

test("halfway through its pull, the aim is turned part of the way", () => {
  const game = world(450, 300);
  peeperAt(game, 650, 300);
  run(game, config.pullSeconds / 2, { x: 450, y: 100 });
  const off = turn(game.local.aim, 0);
  expect(off).toBeGreaterThan(0.2);
  expect(off).toBeLessThan(Math.PI / 2 - 0.2);
});

test("out of the reach of a player's look, or behind a wall, it pulls nothing", () => {
  const far = world(100, 300);
  peeperAt(far, 100 + testSimConfig.vision.lookRange + 50, 300);
  run(far, 1, { x: 100, y: 500 });
  expect(turn(far.local.aim, Math.PI / 2)).toBeLessThan(1e-6);

  // The pillar at x 200-300, y 50-150 stands between them.
  const walled = world(125, 100);
  peeperAt(walled, 375, 100);
  run(walled, 1, { x: 125, y: 500 });
  expect(turn(walled.local.aim, Math.PI / 2)).toBeLessThan(1e-6);
});

test("a player looking at it loses 10 health a second, in ticks", () => {
  const game = world(450, 300);
  const peeper = peeperAt(game, 650, 300);
  const before = game.local.health;
  run(game, 2.05, peeper);
  const lost = before - game.local.health;
  const { damagePerSecond, interval } = config.stare;
  expect(lost).toBeGreaterThanOrEqual(damagePerSecond * (2 - interval));
  expect(lost).toBeLessThanOrEqual(damagePerSecond * 2);
  expect(lost % (damagePerSecond * interval)).toBe(0);
});

test("a gaze caught stings once, and its drone plays while held", () => {
  const game = world(450, 300);
  const peeper = peeperAt(game, 650, 300);
  run(game, 1, peeper);
  expect(played(game).filter((url) => url === "seize.mp3")).toHaveLength(1);
  const type = game.entityTypes.get(peeper.kind);
  expect(type?.plays(peeper, game)).toMatchObject({ key: "stare", loop: true });
});

/** `peeper`, configured for players alone, with no `targets`: it works on any body with eyes. */
function onAnyBody(peeper: PeeperConfig): PeeperConfig {
  const { targets, ...rest } = peeper;
  expect(targets).toEqual(["player"]);
  return rest;
}

test("as configured, a monster's view cone is neither pulled nor hurt, nor the peeper's drone set off", () => {
  // The player stands far off, out of its reach.
  const game = world(100, 550);
  const peeper = peeperAt(game, 450, 100);
  const watcher = spawnEntity(game, "watcher", 350, 250, {});
  run(game, config.pullSeconds + 2, { x: 100, y: 300 });
  expect(eyesOf(game, watcher)?.cone?.direction).toBe(0);
  expect(watcher.health).toBe(100);
  expect(stateOf(peeper).held).toEqual([]);
  expect(played(game)).not.toContain("seize.mp3");
});

test("given no targets, any body with a view cone is pulled and hurt alike, not only players", () => {
  // The player stands far off, out of its reach.
  const game = world(100, 550, onAnyBody(config));
  const peeper = peeperAt(game, 450, 100);
  // It faces right; the peeper lies up and to its left, within its cone's reach.
  const watcher = spawnEntity(game, "watcher", 350, 250, {});
  run(game, DT, { x: 100, y: 300 });
  run(game, config.pullSeconds + 0.1, { x: 100, y: 300 });
  const cone = eyesOf(game, watcher)?.cone;
  expect(turn(cone?.direction ?? 0, aimAt(watcher, peeper))).toBeLessThan(1e-6);
  run(game, 2, { x: 100, y: 300 });
  expect(watcher.health).toBeLessThan(100);
  expect(stateOf(peeper).held).toContain(watcher.id);
});

test("four shovel hits burst it, each with a squelch", () => {
  const game = world(100, 550);
  const peeper = peeperAt(game, 700, 300);
  for (let hit = 0; hit < 3; hit++) {
    hurt(game, peeper, 25, game.localId);
    run(game, DT, { x: 100, y: 300 });
  }
  expect(peeper.health).toBeGreaterThan(0);
  expect(played(game).filter((url) => url === "squelch.mp3")).toHaveLength(3);
  hurt(game, peeper, 25, game.localId);
  run(game, DT, { x: 100, y: 300 });
  expect(game.entities.has(peeper.id)).toBe(false);
});

/** Leaves its place after 2s with no body within 200px, never within 300px of a player. */
const restless: PeeperConfig = {
  ...config,
  spawning: { ...config.spawning, unseenDistance: 300 },
  relocate: { after: 2, range: 200, retry: 1 },
};

test("with no body near long enough, it blinks out to somewhere it might have arrived", () => {
  const game = world(100, 550, restless);
  const peeper = peeperAt(game, 700, 300);
  run(game, 1.5, { x: 100, y: 300 });
  expect(peeper).toMatchObject({ x: 700, y: 300 });
  run(game, 1, { x: 100, y: 300 });
  expect(peeper.x !== 700 || peeper.y !== 300).toBe(true);
  expect(
    Math.hypot(peeper.x - game.local.x, peeper.y - game.local.y),
  ).toBeGreaterThanOrEqual(restless.spawning.unseenDistance);
  expect(played(game).filter((url) => url === "blink.mp3")).toHaveLength(2);
});

test("a body it hunts near keeps it where it is; a monster it leaves be does not", () => {
  const kept = world(100, 550, onAnyBody(restless));
  const peeper = peeperAt(kept, 700, 300);
  spawnEntity(kept, "watcher", 700, 420, {});
  run(kept, 3, { x: 100, y: 300 });
  expect(peeper).toMatchObject({ x: 700, y: 300 });

  const left = world(100, 550, restless);
  const alone = peeperAt(left, 700, 300);
  spawnEntity(left, "watcher", 700, 420, {});
  run(left, 3, { x: 100, y: 300 });
  expect(alone.x !== 700 || alone.y !== 300).toBe(true);
});

test("a gaze is still dragged on a client whose world clock the host keeps putting back", () => {
  const game = world(450, 300);
  const peeper = peeperAt(game, 650, 300);
  const up = { x: 450, y: 0 };
  // As a guest's is, by snapshots arriving later than it has stepped on to.
  for (let step = 0; step < 60; step++) {
    run(game, DT, up);
    if (step % 6 === 5) game.worldTime -= 8 * DT;
  }
  expect(turn(game.local.aim, aimAt(game.local, peeper))).toBeLessThan(1e-6);
});
