import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Noise, Point, Session, WorldEntity } from "../../sim/index.js";
import {
  thumper as thumperContent,
  ThumperState,
  freshThumper,
} from "./index.js";

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
function world(x: number, y: number, kind = config): Session {
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
