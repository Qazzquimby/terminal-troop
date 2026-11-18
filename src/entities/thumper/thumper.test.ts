import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  INERT_TAG,
  isLit,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Noise, Point, Session, WorldEntity } from "../../sim/index.js";
import {
  thumper as thumperContent,
  ThumperState,
  freshThumper,
} from "./index.js";
import type { ThumperConfig } from "./index.js";

const DT = 1 / 60;
const { thumper: config } = testEntitiesConfig;

/** Its running speed under the test config. */
const RUN_SPEED =
  testSimConfig.player.speed *
  testSimConfig.player.sprintMultiplier *
  config.sprintShare;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, all dark; the local player, ME, stands at (x, y).
 */
function world(x: number, y: number, kind: ThumperConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "THUMP",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [thumperContent.create({ thumper: kind })]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player standing, each event the host sends heard at once. */
function run(game: Session, seconds: number): Noise[] {
  const heard: Noise[] = [];
  const controls = {
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
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    for (const { content, event, to, payload } of game.outbox.splice(0))
      receiveEvent(
        game,
        { from: game.localId, to, content, event, payload },
        game.localId,
      );
    for (const { event, payload, sender } of game.inbox.splice(0))
      event.receive(game, payload, sender);
    heard.push(...game.noises);
  }
  return heard;
}

function thumperAt(
  game: Session,
  at: Point,
  change: Partial<ThumperState> = {},
): WorldEntity {
  return spawnEntity(game, "thumper", at.x, at.y, {
    ...freshThumper(game.worldTime),
    ...change,
  });
}

const stateOf = (entity: WorldEntity): ThumperState =>
  ThumperState.parse(entity.data);

/** A corner far from where these tests run, behind a pillar from the middle. */
const FAR = { x: 875, y: 575 };

test("three test shovel hits fell it", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(game, { x: 425, y: 325 });
  expect(thumper.maxHealth).toBe(testItemsConfig.shovel.damage * 3);
});

test("it runs straight at 1.2 times a player's sprint, thumping loud as it goes", () => {
  const game = world(FAR.x, FAR.y);
  // Down the open row between the pillars, heading right.
  const thumper = thumperAt(
    game,
    { x: 75, y: 325 },
    {
      mode: "run",
      facing: 0,
      left: 1000,
    },
  );
  const heard = run(game, 1);
  expect(stateOf(thumper).mode).toBe("run");
  expect(Math.hypot(thumper.vx, thumper.vy)).toBeCloseTo(RUN_SPEED);
  expect(thumper.vy).toBeCloseTo(0);
  expect(thumper.y).toBeCloseTo(325);
  const thumps = heard.filter(
    (noise) =>
      noise.source === thumper.id && noise.radius === config.sounds.thump,
  );
  expect(thumps.length).toBeGreaterThanOrEqual(3);
  expect(config.sounds.thump).toBeGreaterThan(
    testSimConfig.footsteps.sprint.radius,
  );
});

test("a run lasts its least length, then it stands to turn", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(
    game,
    { x: 75, y: 325 },
    {
      mode: "run",
      facing: 0,
      left: 200,
    },
  );
  run(game, 200 / RUN_SPEED + 0.1);
  expect(stateOf(thumper).mode).toBe("turn");
  expect(thumper.x).toBeCloseTo(275, -1);
  expect(Math.hypot(thumper.vx, thumper.vy)).toBe(0);
});

test("a wall ends a run early, with a slam", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(
    game,
    { x: 600, y: 325 },
    {
      mode: "run",
      facing: 0,
      left: 2000,
    },
  );
  // About 230px to the wall, under a second, then it stands 0.8s.
  run(game, 1.2);
  expect(stateOf(thumper).mode).toBe("turn");
  // The square's right wall stands at x 850.
  expect(thumper.x).toBeGreaterThan(800);
  expect(
    vi
      .mocked(game.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("slam.mp3")),
  ).toBe(true);
});

test("with nothing to make for, it turns for a run with room for its least length", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(game, { x: 425, y: 325 }, { facing: Math.PI / 2 });
  run(game, DT * 2);
  const state = stateOf(thumper);
  expect(state.mode).toBe("run");
  expect(state.left).toBeGreaterThan(config.minRun - RUN_SPEED * DT * 3);
});

test("a body it sees, it makes for, and runs into it for 30", () => {
  const game = world(625, 325);
  const thumper = thumperAt(game, { x: 225, y: 325 }, { facing: 0 });
  run(game, DT * 2);
  const state = stateOf(thumper);
  expect(state.mode).toBe("run");
  expect(state.target).not.toBeNull();
  expect(Math.cos(state.facing)).toBeCloseTo(1);
  run(game, 2);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
  expect((game.local.maxHealth - game.local.health) % config.damage).toBe(0);
});

test("it strikes any body it runs into, not only players", () => {
  // Its own kind stands in for any monster, with none ignored.
  const game = world(FAR.x, FAR.y, { ...config, ignores: [] });
  thumperAt(game, { x: 75, y: 325 }, { mode: "run", facing: 0, left: 1000 });
  const other = thumperAt(game, { x: 300, y: 325 }, { until: 1000 });
  run(game, 1.5);
  expect(other.health).toBeLessThan(other.maxHealth);
});

/** Registers a lamp kind, lighting 160px round it, and sets one down at `at`. */
function lampAt(game: Session, at: Point): WorldEntity {
  registerEntityType(game, "lamp", {
    radius: 5,
    // Inert: no body hunts or strikes it, so a thumper leaves the light on.
    maxHealth: 1,
    tags: [INERT_TAG],
    collides: false,
    data: z.object({}),
    light: () => ({ range: 160 }),
    draw: () => undefined,
  });
  return spawnEntity(game, "lamp", at.x, at.y, {});
}

const played = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

test("light falling on it, it recoils with a snort and makes for the dark before the body it saw", () => {
  const game = world(625, 325);
  const thumper = thumperAt(game, { x: 225, y: 325 }, { facing: 0 });
  run(game, DT * 2);
  expect(stateOf(thumper).target).toMatchObject({ x: 625, y: 325 });
  lampAt(game, { x: thumper.x + 20, y: thumper.y });
  run(game, DT);
  const fleeing = stateOf(thumper);
  expect(fleeing.fleeing).toBe(true);
  expect(fleeing.mode).toBe("run");
  expect(fleeing.target).not.toBeNull();
  expect(Math.cos(fleeing.facing)).toBeLessThan(0);
  expect(isLit(game, fleeing.target ?? thumper)).toBe(false);
  expect(played(game, "recoil.mp3")).toBe(true);
  // It runs from the lamp, away from the body it saw, until it stands in the dark.
  run(game, 1.5);
  expect(isLit(game, thumper)).toBe(false);
  expect(stateOf(thumper).fleeing).toBe(false);
});

test("light on it as it stands to turn, it cuts the turn short for the dark", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(game, { x: 425, y: 325 }, { until: 1000 });
  lampAt(game, { x: 425, y: 325 });
  run(game, DT);
  expect(stateOf(thumper).mode).toBe("run");
  expect(stateOf(thumper).fleeing).toBe(true);
  run(game, 1.5);
  expect(isLit(game, thumper)).toBe(false);
});

test("hurt, it rages with a bellow, minding no light, and goes for whatever hurt it", () => {
  const game = world(625, 325);
  const thumper = thumperAt(game, { x: 225, y: 325 }, { until: 1000 });
  lampAt(game, { x: 225, y: 325 });
  hurt(game, thumper, 10, game.localId);
  run(game, DT * 2);
  const state = stateOf(thumper);
  expect(state.enraged).toBe(true);
  expect(state.fleeing).toBe(false);
  expect(state.target).toMatchObject({ x: 625, y: 325 });
  expect(played(game, "enrage.mp3")).toBe(true);
  expect(played(game, "recoil.mp3")).toBe(false);
});

test("its rage spent, light sends it for the dark again", () => {
  const game = world(FAR.x, FAR.y);
  const thumper = thumperAt(game, { x: 425, y: 325 }, { until: 1000 });
  lampAt(game, { x: 425, y: 325 });
  hurt(game, thumper, 10, null);
  run(game, DT * 2);
  expect(stateOf(thumper).enraged).toBe(true);
  // Back in the light as the rage ends, wherever it ran meanwhile.
  run(game, config.rageSeconds);
  Object.assign(thumper, { x: 425, y: 325 });
  run(game, DT);
  expect(stateOf(thumper).enraged).toBe(false);
  expect(stateOf(thumper).fleeing).toBe(true);
});

test("a kind that does not seek the dark pays light no mind", () => {
  const game = world(625, 325, { ...config, seeksDark: false });
  const thumper = thumperAt(game, { x: 225, y: 325 }, { facing: 0 });
  lampAt(game, { x: 225, y: 325 });
  run(game, DT * 2);
  expect(stateOf(thumper).fleeing).toBe(false);
  expect(stateOf(thumper).target).toMatchObject({ x: 625, y: 325 });
});
