import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  applyEntitySnapshot,
  createPlayer,
  createSession,
  entitySnapshot,
  livingBodies,
  mulberry32,
  noisesHeardBy,
  perceives,
  pocketAt,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { nearestSeenBody } from "../bodies.js";
import { freshGhostGirl, ghostGirl, GhostGirlState } from "./index.js";

const DT = 1 / 60;
const { ghostGirl: config } = testEntitiesConfig;

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(7));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The dev square, 900x600, all dark, its pillars filling (200..300, 50..150) and
 * (600..700, 450..550); the local player stands at (x, y).
 */
function world(x: number, y: number): Session {
  const game = createSession(
    "me",
    "ME",
    "GHOST",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [
    ghostGirl.create(testEntitiesConfig),
    zombieContent.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player aiming at `aim`, each event the host sends taken at once. */
function run(game: Session, seconds: number, aim: Point): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim,
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
  }
}

/** A ghost girl at (x, y), haunting the local player, in `state` past a fresh one's. */
function girlAt(
  game: Session,
  x: number,
  y: number,
  state: Partial<GhostGirlState> = {},
): WorldEntity {
  return spawnEntity(game, "ghostGirl", x, y, {
    ...freshGhostGirl(game.worldTime),
    target: "me",
    ...state,
  });
}

const stateOf = (girl: WorldEntity) => GhostGirlState.parse(girl.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

const stared = (game: Session): boolean =>
  vi
    .mocked(game.sfx.play)
    .mock.calls.some(([url]) => /stare-\d\.mp3$/.test(url));

/** A staring girl with her stare's patience, `patience` past the default. */
const staring = (state: Partial<GhostGirlState> = {}) => ({
  mode: "staring" as const,
  patience: config.patience.start,
  ...state,
});

test("she chooses the only player to haunt and stays away, off the map, there for it alone", () => {
  const game = world(450, 300);
  const girl = spawnEntity(
    game,
    "ghostGirl",
    800,
    300,
    freshGhostGirl(game.worldTime),
  );
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({ mode: "absent", target: "me" });
  expect(girl.x).toBeLessThan(0);
  // Parked above and left of the map, never in a pocket under it, so no pocketball counts her.
  expect(pocketAt(game.world.map, girl)).toBeNull();

  expect(perceives(game, "me", girl.id)).toBe(true);
  expect(perceives(game, "someone else", girl.id)).toBe(false);
  expect(perceives(game, null, girl.id)).toBe(false);
  expect(livingBodies(game).map(({ id }) => id)).not.toContain(girl.id);
  expect(livingBodies(game, "me").map(({ id }) => id)).toContain(girl.id);
});

test("no other body sees her: a zombie with her between it and the player sees the player", () => {
  const game = world(400, 300);
  const girl = girlAt(game, 300, 300, staring({ seen: true }));
  const zombie = spawnEntity(
    game,
    "zombie",
    250,
    300,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  expect(nearestSeenBody(game, zombie, testEntitiesConfig.zombie)?.id).toBe(
    "me",
  );
  expect(livingBodies(game, zombie.id).map(({ id }) => id)).not.toContain(
    girl.id,
  );
});

test("her time come, she appears 4 to 12 cells behind her target, outside its view cone, with a clear line to it", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 800, 300, { until: game.worldTime });
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({
    mode: "staring",
    seen: false,
    onMinimap: false,
  });
  expect(stateOf(girl).patience).toBeCloseTo(config.patience.start, 0);
  const distance = Math.hypot(girl.x - 450, girl.y - 300);
  expect(distance).toBeGreaterThanOrEqual(config.appear.near - 1);
  expect(distance).toBeLessThanOrEqual(config.appear.far + 1);
  const off = Math.abs(Math.atan2(girl.y - 300, girl.x - 450));
  expect(off).toBeGreaterThanOrEqual(
    testSimConfig.vision.coneAngle / 2 + config.appear.behind - 1e-6,
  );
  expect(sounded(game, "appear.mp3")).toBe(true);
  expect(stared(game)).toBe(true);
});

test("a look angers her once a stare, and at 1 or 2 anger she only stares on, her patience held", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 750, 300, staring({ anger: 1 }));
  run(game, 2, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({
    mode: "staring",
    anger: 2,
    seen: true,
  });
  expect(stateOf(girl).patience).toBeCloseTo(config.patience.start, 1);
  expect(girl.x).toBe(750);
});

test("in plain sight but unwatched her patience drains, and out of her target's view she is gone the moment it runs out", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 750, 300, staring({ seen: true, patience: 2 }));
  run(game, 1, { x: 0, y: 300 });
  expect(stateOf(girl).patience).toBeCloseTo(1, 1);
  run(game, 1.1, { x: 0, y: 300 });
  expect(stateOf(girl).mode).toBe("absent");
  expect(girl.x).toBeLessThan(0);
});

test("with no clear line to her target her patience grows", () => {
  // The pillar at (200..300, 50..150) stands between them.
  const game = world(100, 100);
  const girl = girlAt(game, 450, 100, staring({ seen: true }));
  run(game, 2, { x: 0, y: 100 });
  expect(stateOf(girl).patience).toBeCloseTo(config.patience.start + 2, 1);
});

test("slipping away while watched, she walks off and is gone once out of sight, or soon enough regardless", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 750, 300, {
    mode: "disappearing",
    searchUntil: game.worldTime + config.hide.search,
    until: game.worldTime + config.hide.giveUp,
  });
  run(game, 0.2, { x: 750, y: 300 });
  expect(stateOf(girl).mode).toBe("disappearing");
  expect(Math.hypot(girl.vx, girl.vy)).toBeGreaterThan(0);
  for (
    let i = 0;
    i < 60 * config.hide.giveUp && stateOf(girl).mode !== "absent";
    i++
  )
    run(game, DT, { x: girl.x, y: girl.y });
  expect(stateOf(girl).mode).toBe("absent");
});

test("from 3 anger a look may set her on her target", () => {
  const game = world(450, 300);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const girl = girlAt(game, 750, 300, staring({ anger: 2 }));
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({ mode: "chasing", anger: 3 });
  expect(sounded(game, "chase.mp3")).toBe(true);
});

test("chasing, she goes through walls, costs her target 20 health a second while she touches it, then flickers and vanishes", () => {
  const game = world(100, 100);
  // Inside the pillar at (200..300, 50..150).
  const girl = girlAt(game, 250, 100, {
    mode: "chasing",
    anger: 3,
    until: game.worldTime + 3,
  });
  run(game, 0.3, { x: 0, y: 100 });
  expect(girl.x).toBeLessThan(250);
  expect(girl.vx).toBeLessThan(0);
  // Caught up within a second; 1.5 more seconds touching.
  run(game, 1, { x: 0, y: 100 });
  const caught = game.local.health;
  run(game, 1.5, { x: 0, y: 100 });
  // 5 every quarter second, give or take a blow at either end.
  expect(caught - game.local.health).toBeGreaterThanOrEqual(1.5 * 20 - 5);
  expect(caught - game.local.health).toBeLessThanOrEqual(1.5 * 20 + 5);

  run(game, 0.3, { x: 0, y: 100 });
  expect(stateOf(girl).mode).toBe("vanishing");
  expect(sounded(game, "vanish.mp3")).toBe(true);
  const health = game.local.health;
  run(game, config.flicker + DT, { x: 0, y: 100 });
  expect(stateOf(girl).mode).toBe("absent");
  expect(game.local.health).toBe(health);
});

test("her target gone, she chooses another, her anger gone", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 750, 300, staring({ anger: 4, target: "gone" }));
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({
    mode: "absent",
    target: "me",
    anger: 0,
  });
});

test("her target in the cabin, she stares out of the minimap instead, seen at once", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 800, 300, { until: game.worldTime });
  const ride = {
    vehicle: "car",
    driving: false,
    heading: 0,
    speed: 0,
    turn: 0,
  };
  game.local.ride = ride;
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl)).toMatchObject({
    mode: "staring",
    onMinimap: true,
    seen: true,
    anger: 1,
  });
  expect(girl.x).toBeLessThan(0);
  expect(stared(game)).toBe(true);
});

test("only her target's client plays her sounds, and only her target hears her noise", () => {
  const game = world(100, 100);
  const them = createPlayer("them", "THEM", { x: 450, y: 300 }, testSimConfig);
  game.players.set(them.id, them);
  const girl = girlAt(game, 800, 300, {
    target: "them",
    until: game.worldTime,
  });
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(girl).mode).toBe("staring");
  expect(sounded(game, "appear.mp3")).toBe(false);
  expect(stared(game)).toBe(false);
  const listen = (id: string) =>
    noisesHeardBy(game, { id, at: them, rng: Math.random }).filter(
      ({ source }) => source === girl.id,
    );
  expect(listen("them").length).toBeGreaterThan(0);
  expect(listen("me")).toEqual([]);
});

test("a client takes her from a snapshot even inside a wall", () => {
  const game = world(450, 300);
  const girl = girlAt(game, 250, 100, { mode: "chasing" });
  const snapshot = entitySnapshot(game);
  const other = world(450, 300);
  applyEntitySnapshot(other, snapshot);
  expect(other.entities.get(girl.id)).toMatchObject({ x: 250, y: 100 });
});
