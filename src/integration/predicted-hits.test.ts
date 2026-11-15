import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { teleport } from "./crew.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const { kick } = testMovesConfig;
const { shovel } = testItemsConfig;
const DT = 1 / 60;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
const MAX_HEALTH = testEntitiesConfig.zombie.maxHealth;
const idle: Controls = {
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

/** One blind zombie, so it stays where it is put. */
const entities = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    sightRange: 0,
    wanderSpeed: 0,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 1 },
  },
};

/** No scrap lying about. */
const items = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

/** Where the guest stands, clear of every wall, facing right. */
const GUEST = { x: 150, y: 300 };
/** Where a kick from GUEST lands, once the guest has lunged a body length. */
const KICKED = { x: GUEST.x + PLAYER_LENGTH + kick.reach, y: GUEST.y };
/** Where a shovel swung from GUEST lands. */
const SWUNG = { x: GUEST.x + shovel.reach, y: GUEST.y };

const facingRight = (game: Session): Point => ({
  x: game.local.x + 1000,
  y: game.local.y,
});
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: facingRight(game),
});
const swingRight = (game: Session): Controls => ({
  ...idle,
  use: true,
  aim: facingRight(game),
});

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function zombieOf(room: Room): WorldEntity {
  const game = sessionOf(room);
  const kind = game.kindIds.get("zombie");
  const zombie = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (zombie === undefined) throw new Error("no zombie");
  return zombie;
}

/**
 * Host `a` and guest `b` on one hub, the guest standing at GUEST and the zombie at `target` on
 * both clients, the guest's copy settled there.
 */
async function lineUp(target: Point) {
  const hub = createHub();
  const clock = createManualClock();
  const client = (id: string): Room =>
    createRoom({
      localId: id,
      world: "dev",
      transport: hub.transport(id, []).port,
      voice: createNullVoice({
        mode: "open",
        muted: false,
        volume: 1,
        inputDevice: null,
      }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: [
        ...entityContent(entities),
        ...moveContent(testMovesConfig),
        ...itemContent(items),
      ],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("HITS", "A");
  await b.join("HITS", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  for (const room of [a, b])
    vi.spyOn(sessionOf(room).sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });

  /** Steps `room` once with `controls`. */
  const step = (room: Room, controls: Controls = idle): void => {
    updateSession(sessionOf(room), controls, DT);
  };
  /** Lets `room` send what its steps queued, 200ms on, so it ticks. */
  const frame = (room: Room): void => {
    clock.advance(clock.now() + 200);
    room.frame(clock.now());
  };
  /**
   * Runs the host until its run of the guest reaches the guest's latest step, which applies what
   * the guest did up to it.
   */
  const catchUp = (): void => {
    const guest = sessionOf(b);
    const feeds = sessionOf(a).feeds;
    for (let count = 0; count < 600; count++) {
      if ((feeds.get("b")?.label ?? -Infinity) >= guest.step) return;
      step(a);
    }
    throw new Error("the host never caught up with the guest");
  };
  /** Steps both clients and lets each send, the host as far as the guest's step. */
  const exchange = (): void => {
    step(b);
    frame(b);
    catchUp();
    frame(a);
  };
  /** Runs both clients side by side for `seconds`, each sending as it goes. */
  const settle = (seconds: number): void => {
    for (let count = 0; count < Math.round(seconds / DT); count++)
      for (const room of [b, a]) {
        step(room);
        clock.advance(clock.now() + 1000 * DT);
        room.frame(clock.now());
      }
  };
  /** Puts the zombie at `at` on both clients. */
  const putZombie = (at: Point): void => {
    Object.assign(zombieOf(a), { ...at, tx: at.x, ty: at.y });
    Object.assign(zombieOf(b), {
      ...at,
      prevX: at.x,
      prevY: at.y,
      tx: at.x,
      ty: at.y,
    });
  };
  /** Puts the guest at GUEST where the host runs it, lets the guest hear so, and the zombie at `at`. */
  const reset = (at: Point): void => {
    teleport([sessionOf(a), sessionOf(b)], "b", GUEST);
    settle(1);
    putZombie(at);
  };
  reset(target);
  expect(sessionOf(b).local).toMatchObject(GUEST);
  expect(zombieOf(b)).toMatchObject({ ...target, tx: target.x });
  return { hub, a, b, step, frame, catchUp, exchange, putZombie };
}

/** The guest's zombie x over `steps` idle steps of the guest. */
function track(
  b: Room,
  step: (room: Room) => void,
  steps: number,
): { x: number[]; health: number[] } {
  const x: number[] = [];
  const health: number[] = [];
  for (let count = 0; count < steps; count++) {
    step(b);
    x.push(zombieOf(b).x);
    health.push(zombieOf(b).health);
  }
  return { x, health };
}

/** The largest move between neighbouring values of `xs`, starting from `from`. */
const largestStep = (from: number, xs: readonly number[]): number =>
  Math.max(...xs.map((x, index) => Math.abs(x - (xs[index - 1] ?? from))));

/** How far a kick knocks the zombie, a player's mass: two of the kicker's body lengths. */
const KNOCK = PLAYER_LENGTH * kick.knockback;

test("a guest's kick knocks the zombie back on its own client at once, and its lunge carries on", async () => {
  const { b, step } = await lineUp(KICKED);
  const guest = sessionOf(b);
  step(b, kickRight(guest));
  const zombie = zombieOf(b);
  expect(zombie.x - KICKED.x).toBeGreaterThan(KNOCK - 5);
  expect(zombie.x - KICKED.x).toBeLessThanOrEqual(KNOCK);
  expect(zombie.health).toBe(MAX_HEALTH - kick.damage);
  for (let count = 0; count < Math.round(kick.lunge.seconds / DT); count++)
    step(b);
  expect(guest.local.x - GUEST.x).toBeCloseTo(PLAYER_LENGTH);
});

test("snapshots from before the host's hit do not pull the predicted zombie back", async () => {
  const { hub, a, b, step, frame } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = { ...zombieOf(b) };
  // The host moves the zombie and sends it, before the kick reaches it.
  Object.assign(zombieOf(a), { x: KICKED.x - 3 });
  step(a);
  frame(a);
  hub.release("b");
  expect(zombieOf(b).tx).toBeCloseTo(KICKED.x - 3, 0);
  const held = track(b, step, 20);
  expect(held.x.every((x) => x === predicted.x)).toBe(true);
  expect(held.health.every((h) => h === predicted.health)).toBe(true);
});

test("the snapshot that shows the hit takes over smoothly, and agrees on damage", async () => {
  const { hub, a, b, step, frame, catchUp } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = { ...zombieOf(b) };
  // The host's zombie stands a little off where the guest drew it.
  Object.assign(zombieOf(a), { x: KICKED.x + 6 });
  hub.release("a");
  catchUp();
  const onHost = zombieOf(a);
  expect(onHost.health).toBe(predicted.health);
  expect(Math.abs(onHost.x - predicted.x)).toBeGreaterThan(3);
  frame(a);
  hub.release("b");
  const taken = track(b, step, 60);
  const gap = Math.abs(onHost.x - predicted.x);
  expect(largestStep(predicted.x, taken.x)).toBeLessThan(gap * 0.25);
  expect(taken.x.at(-1)).toBeCloseTo(onHost.x, 0);
  expect(taken.health.every((h) => h === onHost.health)).toBe(true);
  expect(sessionOf(b).predictions.size).toBe(0);
});

test("a kick the host turns down eases the zombie back to where the host has it", async () => {
  const { a, b, step, frame, exchange, putZombie } = await lineUp(KICKED);
  const guest = sessionOf(b);
  step(b, kickRight(guest));
  exchange();
  expect(zombieOf(a).health).toBe(MAX_HEALTH - kick.damage);
  // The guest kicks again within the host's cooldown, from the end of its lunge, its own count
  // cleared.
  for (let count = 0; count < Math.round(kick.lunge.seconds / DT) + 2; count++)
    step(b);
  frame(b);
  const again = { x: guest.local.x + PLAYER_LENGTH + kick.reach, y: GUEST.y };
  putZombie(again);
  guest.localReadyAt.clear();
  step(b, kickRight(guest));
  const predicted = { ...zombieOf(b) };
  expect(predicted.x - again.x).toBeGreaterThan(KNOCK - 5);
  expect(predicted.health).toBe(MAX_HEALTH - 2 * kick.damage);
  exchange();
  expect(zombieOf(a)).toMatchObject({
    x: again.x,
    health: MAX_HEALTH - kick.damage,
  });
  const eased = track(b, step, 90);
  expect(largestStep(predicted.x, eased.x)).toBeLessThan(KNOCK * 0.25);
  expect(eased.x.at(-1)).toBeCloseTo(again.x, 0);
  expect(eased.health.at(-1)).toBe(MAX_HEALTH - kick.damage);
});

test("with no word from the host, the guest lets go once the hold runs out", async () => {
  const { hub, b, step, frame } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = zombieOf(b).x;
  const holdSteps = Math.round(testSimConfig.net.predictionHold / DT);
  const held = track(b, step, holdSteps - 2);
  expect(held.x.every((x) => x === predicted)).toBe(true);
  const after = track(b, step, 90);
  expect(largestStep(predicted, after.x)).toBeLessThan(KNOCK * 0.25);
  expect(after.x.at(-1)).toBeCloseTo(KICKED.x, 0);
  expect(after.health.at(-1)).toBe(MAX_HEALTH);
});

test("a guest's shovel swing is predicted, held and confirmed alike", async () => {
  const { hub, a, b, step, frame, catchUp } = await lineUp(SWUNG);
  hub.hold();
  step(b, swingRight(sessionOf(b)));
  frame(b);
  const predicted = { ...zombieOf(b) };
  expect(predicted.x).toBeCloseTo(SWUNG.x + shovel.knockback);
  expect(predicted.health).toBe(MAX_HEALTH - shovel.damage);

  Object.assign(zombieOf(a), { x: SWUNG.x - 2 });
  step(a);
  frame(a);
  hub.release("b");
  expect(track(b, step, 10).x.every((x) => x === predicted.x)).toBe(true);

  hub.release("a");
  catchUp();
  const onHost = zombieOf(a);
  expect(onHost.health).toBe(predicted.health);
  frame(a);
  hub.release("b");
  const taken = track(b, step, 60);
  expect(taken.x.at(-1)).toBeCloseTo(onHost.x, 0);
  expect(taken.health.every((h) => h === onHost.health)).toBe(true);
  expect(sessionOf(b).predictions.size).toBe(0);
});
