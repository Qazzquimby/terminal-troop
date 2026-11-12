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
const CHASER_LENGTH = testEntitiesConfig.chaser.radius * 2;
const MAX_HEALTH = testEntitiesConfig.chaser.maxHealth;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

/** One blind chaser, so it stays where it is put. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    wanderSpeed: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 1 },
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

function chaserOf(room: Room): WorldEntity {
  const game = sessionOf(room);
  const kind = game.kindIds.get("chaser");
  const chaser = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (chaser === undefined) throw new Error("no chaser");
  return chaser;
}

/**
 * Host `a` and guest `b` on one hub, the guest standing at GUEST and the chaser at `target` on
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
  /** Steps both clients and lets each send. */
  const exchange = (): void => {
    step(b);
    frame(b);
    step(a);
    frame(a);
  };
  /** Puts the guest at GUEST and the chaser at `at` on the host, and lets the guest hear it. */
  const reset = (at: Point): void => {
    Object.assign(sessionOf(b).local, { ...GUEST, prevX: GUEST.x });
    Object.assign(chaserOf(a), { ...at, tx: at.x, ty: at.y });
    exchange();
    exchange();
    Object.assign(chaserOf(b), { ...at, prevX: at.x, prevY: at.y });
  };
  reset(target);
  expect(chaserOf(b)).toMatchObject({ ...target, tx: target.x });
  return { hub, a, b, step, frame, exchange, reset };
}

/** The guest's chaser x over `steps` idle steps of the guest. */
function track(
  b: Room,
  step: (room: Room) => void,
  steps: number,
): { x: number[]; health: number[] } {
  const x: number[] = [];
  const health: number[] = [];
  for (let count = 0; count < steps; count++) {
    step(b);
    x.push(chaserOf(b).x);
    health.push(chaserOf(b).health);
  }
  return { x, health };
}

/** The largest move between neighbouring values of `xs`, starting from `from`. */
const largestStep = (from: number, xs: readonly number[]): number =>
  Math.max(...xs.map((x, index) => Math.abs(x - (xs[index - 1] ?? from))));

/** How far a kick knocks the chaser. */
const KNOCK = CHASER_LENGTH * kick.knockback;

test("a guest's kick knocks the chaser back on its own client at once, and its lunge carries on", async () => {
  const { b, step } = await lineUp(KICKED);
  const guest = sessionOf(b);
  step(b, kickRight(guest));
  const chaser = chaserOf(b);
  expect(chaser.x - KICKED.x).toBeGreaterThan(KNOCK - 5);
  expect(chaser.x - KICKED.x).toBeLessThanOrEqual(KNOCK);
  expect(chaser.health).toBe(MAX_HEALTH - kick.damage);
  for (let count = 0; count < Math.round(kick.lunge.seconds / DT); count++)
    step(b);
  expect(guest.local.x - GUEST.x).toBeCloseTo(PLAYER_LENGTH);
});

test("snapshots from before the host's hit do not pull the predicted chaser back", async () => {
  const { hub, a, b, step, frame } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = { ...chaserOf(b) };
  // The host moves the chaser and sends it, before the kick reaches it.
  Object.assign(chaserOf(a), { x: KICKED.x - 3 });
  step(a);
  frame(a);
  hub.release("b");
  expect(chaserOf(b).tx).toBeCloseTo(KICKED.x - 3, 0);
  const held = track(b, step, 20);
  expect(held.x.every((x) => x === predicted.x)).toBe(true);
  expect(held.health.every((h) => h === predicted.health)).toBe(true);
});

test("the snapshot that shows the hit takes over smoothly, and agrees on damage", async () => {
  const { hub, a, b, step, frame } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = { ...chaserOf(b) };
  // The host's chaser stands a little off where the guest drew it.
  Object.assign(chaserOf(a), { x: KICKED.x + 6 });
  hub.release("a");
  step(a);
  const onHost = chaserOf(a);
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

test("a kick the host turns down eases the chaser back to where the host has it", async () => {
  const { a, b, step, exchange, reset } = await lineUp(KICKED);
  const guest = sessionOf(b);
  step(b, kickRight(guest));
  exchange();
  expect(chaserOf(a).health).toBe(MAX_HEALTH - kick.damage);
  // The guest kicks again within the host's cooldown, its own count cleared.
  reset(KICKED);
  guest.localReadyAt.clear();
  step(b, kickRight(guest));
  const predicted = { ...chaserOf(b) };
  expect(predicted.x - KICKED.x).toBeGreaterThan(KNOCK - 5);
  expect(predicted.health).toBe(MAX_HEALTH - 2 * kick.damage);
  exchange();
  expect(chaserOf(a)).toMatchObject({
    x: KICKED.x,
    health: MAX_HEALTH - kick.damage,
  });
  const eased = track(b, step, 90);
  expect(largestStep(predicted.x, eased.x)).toBeLessThan(KNOCK * 0.25);
  expect(eased.x.at(-1)).toBeCloseTo(KICKED.x, 0);
  expect(eased.health.at(-1)).toBe(MAX_HEALTH - kick.damage);
});

test("with no word from the host, the guest lets go once the hold runs out", async () => {
  const { hub, b, step, frame } = await lineUp(KICKED);
  hub.hold();
  step(b, kickRight(sessionOf(b)));
  frame(b);
  const predicted = chaserOf(b).x;
  const holdSteps = Math.round(testSimConfig.net.predictionHold / DT);
  const held = track(b, step, holdSteps - 2);
  expect(held.x.every((x) => x === predicted)).toBe(true);
  const after = track(b, step, 90);
  expect(largestStep(predicted, after.x)).toBeLessThan(KNOCK * 0.25);
  expect(after.x.at(-1)).toBeCloseTo(KICKED.x, 0);
  expect(after.health.at(-1)).toBe(MAX_HEALTH);
});

test("a guest's shovel swing is predicted, held and confirmed alike", async () => {
  const { hub, a, b, step, frame } = await lineUp(SWUNG);
  hub.hold();
  step(b, swingRight(sessionOf(b)));
  frame(b);
  const predicted = { ...chaserOf(b) };
  expect(predicted.x).toBeCloseTo(SWUNG.x + shovel.knockback);
  expect(predicted.health).toBe(MAX_HEALTH - shovel.damage);

  Object.assign(chaserOf(a), { x: SWUNG.x - 2 });
  step(a);
  frame(a);
  hub.release("b");
  expect(track(b, step, 10).x.every((x) => x === predicted.x)).toBe(true);

  hub.release("a");
  step(a);
  const onHost = chaserOf(a);
  expect(onHost.health).toBe(predicted.health);
  frame(a);
  hub.release("b");
  const taken = track(b, step, 60);
  expect(taken.x.at(-1)).toBeCloseTo(onHost.x, 0);
  expect(taken.health.every((h) => h === onHost.health)).toBe(true);
  expect(sessionOf(b).predictions.size).toBe(0);
});
