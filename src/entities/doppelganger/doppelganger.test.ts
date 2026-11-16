import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { itemContent } from "../../items/index.js";
import {
  CORPSE_ITEM,
  createSession,
  FOOTSTEP_TAG,
  hurt,
  itemInstances,
  itemName,
  receiveEvent,
  registerContent,
  revive,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Noise, Point, Session, WorldEntity } from "../../sim/index.js";
import {
  doppelganger as doppelgangerContent,
  DoppelgangerState,
  freshDoppelganger,
} from "./index.js";

const DT = 1 / 60;
const { doppelganger: config } = testEntitiesConfig;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, all dark; the local player, ME, stands at (x, y).
 */
function world(x: number, y: number): Session {
  const game = createSession(
    "me",
    "ME",
    "DOUBLE",
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
    doppelgangerContent.create({ doppelganger: config }),
    ...itemContent(testItemsConfig),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player looking at `look`, each event the host sends heard at once. */
function run(game: Session, seconds: number, look: Point): Noise[] {
  const heard: Noise[] = [];
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

/** A doppelganger of ME at (x, y), holding `held`, changed by `change`. */
function doubleAt(
  game: Session,
  x: number,
  y: number,
  change: Partial<DoppelgangerState> = {},
): WorldEntity {
  return spawnEntity(game, "doppelganger", x, y, {
    ...freshDoppelganger(7, { id: "me", name: "ME" }),
    watchedAt: game.worldTime,
    ...change,
  });
}

const stateOf = (entity: WorldEntity): DoppelgangerState =>
  DoppelgangerState.parse(entity.data);

/** Away to the right, where nothing in these tests stands. */
const AWAY = { x: 900, y: 325 };

test("it stands as a player does: a player's size and health", () => {
  const game = world(875, 575);
  const double = doubleAt(game, 125, 325);
  expect(double.radius).toBe(game.local.radius);
  expect(double.maxHealth).toBe(game.local.maxHealth);
});

test("watched, it wanders, looking round each spot it stops at, and never heads for the watcher", () => {
  const game = world(475, 325);
  const double = doubleAt(game, 125, 325, { known: { x: 475, y: 325 } });
  const facings = new Set<number>();
  for (let tick = 0; tick < 40; tick++) {
    run(game, 0.1, double);
    expect(stateOf(double).mode).toBe("wander");
    facings.add(stateOf(double).facing);
  }
  // Its head turns as it looks round, or it walks off somewhere, but it never comes on.
  expect(facings.size).toBeGreaterThan(3);
});

test("unwatched for 2s, it heads at a player's walk for where it last knew a body to be", () => {
  const game = world(875, 575);
  const double = doubleAt(game, 125, 325, { known: { x: 475, y: 325 } });
  run(game, 1.5, AWAY);
  expect(stateOf(double).mode).toBe("wander");
  run(game, 1, AWAY);
  expect(stateOf(double).mode).toBe("approach");
  expect(Math.hypot(double.vx, double.vy)).toBeCloseTo(
    testSimConfig.player.speed,
  );
  expect(config.speed).toBe(testSimConfig.player.speed);
});

test("once there and finding no one, it wanders again", () => {
  const game = world(875, 575);
  const double = doubleAt(game, 125, 325, {
    known: { x: 225, y: 325 },
    watchedAt: -10,
  });
  run(game, 2, AWAY);
  expect(stateOf(double).mode).toBe("wander");
  expect(stateOf(double).known).toBeNull();
});

test("a body within a few steps it runs at and bites as a zombie does, with a sound", () => {
  const game = world(475, 325);
  doubleAt(game, 430, 325);
  run(game, 0.5, { x: 0, y: 325 });
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
  expect(
    vi
      .mocked(game.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("attack.mp3")),
  ).toBe(true);
});

test("it walks with a walking player's footsteps", () => {
  const game = world(875, 575);
  const double = doubleAt(game, 125, 325, { route: [{ x: 425, y: 325 }] });
  const steps = run(game, 1.05, AWAY).filter(
    (noise) => noise.source === double.id && noise.tags.includes(FOOTSTEP_TAG),
  );
  expect(double.vx).not.toBe(0);
  const { interval, radius } = testSimConfig.footsteps.walk;
  // One as it sets off, then one each walking step's interval.
  expect(steps).toHaveLength(Math.floor(1 / interval) + 1);
  expect(steps.every((step) => step.radius === radius)).toBe(true);
});

test("felled, it drops what it held and leaves its player's corpse, which brought back rises as it again", () => {
  const game = world(875, 575);
  const double = doubleAt(game, 425, 325, { held: "shovel" });
  hurt(game, double, double.maxHealth, game.localId);
  run(game, 0.1, AWAY);
  expect(game.entities.has(double.id)).toBe(false);
  expect(
    itemInstances(game, "shovel").some(({ place }) => "lying" in place),
  ).toBe(true);
  const [corpse] = itemInstances(game, CORPSE_ITEM);
  if (corpse === undefined) throw new Error("no corpse");
  expect(
    itemName(game, { id: CORPSE_ITEM, name: "Corpse", state: corpse.state }),
  ).toBe("ME's corpse");
  const risen = revive(game, corpse.state, { x: 425, y: 325 }, game.localId);
  expect(risen).not.toBeNull();
  expect(itemInstances(game, CORPSE_ITEM)).toEqual([]);
  const doubles = [...game.entities.values()].filter(
    (entity) => entity === risen,
  );
  expect(doubles).toHaveLength(1);
  const state = stateOf(doubles[0] ?? double);
  expect(state.copies).toBe("me");
  expect(state.name).toBe("ME");
  expect(state.held).toBeNull();
});
