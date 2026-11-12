import { expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRipples } from "../render/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  applyRemoteState,
  heldItemOf,
  mulberry32,
  playerState,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import { createSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testSfx,
  testItemsConfig,
  testRippleConfig,
  testSimConfig,
} from "./sim-config.js";

const { shovel } = testItemsConfig;
const DT = 1 / 60;
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
const swing: Controls = { ...idle, use: true };

/** A kind that stands still with 40 health. */
const DUMMY = "dummy";

function mute(game: Session): void {
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
}

/** A dev-square session holding the starting shovel, with the test items registered and sound muted. */
function session() {
  const game = createSession(
    "me",
    "ME",
    "ITEMS",
    "dev",
    testSfx(),
    testSimConfig,
  );
  mute(game);
  registerContent(game, itemContent(testItemsConfig));
  registerEntityType(game, DUMMY, {
    radius: 15,
    maxHealth: 40,
    data: z.object({}),
    update: (_entity, data) => data,
    draw: () => undefined,
  });
  return game;
}

/** Steps `game` `seconds` with no input. */
function wait(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** Hands each event the session sent back to it, as the room does while it hosts. */
function deliverOwn(game: Session): void {
  for (const { content, event, to, payload } of game.outbox.splice(0))
    receiveEvent(
      game,
      { from: game.localId, to, content, event, payload },
      game.localId,
    );
}

/** Swings facing right, and hands the swing to the session's host step as the room would. */
function swingRight(game: Session): void {
  const { local } = game;
  updateSession(game, { ...swing, aim: { x: local.x + 100, y: local.y } }, DT);
  deliverOwn(game);
  updateSession(game, idle, DT);
}

test("the select control picks a slot, and null keeps the current one", () => {
  const game = session();
  expect(game.local.held).toBe(0);
  updateSession(game, { ...idle, select: 3 }, DT);
  expect(game.local.held).toBe(3);
  updateSession(game, idle, DT);
  expect(game.local.held).toBe(3);
});

test("with six slots, keys 7 to 9 select nothing: the player holds no item", () => {
  const game = createSession("me", "ME", "ITEMS", "dev", testSfx(), {
    ...testSimConfig,
    player: { ...testSimConfig.player, inventorySlots: 6 },
  });
  registerContent(game, itemContent(testItemsConfig));
  for (const slot of [6, 7, 8]) {
    updateSession(game, { ...idle, select: 0 }, DT);
    expect(heldItemOf(game, game.local)?.id).toBe("shovel");
    updateSession(game, { ...idle, select: slot }, DT);
    expect(game.local.held).toBeNull();
    expect(heldItemOf(game, game.local)).toBeNull();
    expect(playerState(game).content["core/items"]).toBeNull();
  }
  updateSession(game, { ...idle, select: 5 }, DT);
  expect(game.local.held).toBe(5);
});

test("the inventory has the configured slots, the shovel in the first", () => {
  const game = session();
  expect(game.local.inventory).toHaveLength(
    testSimConfig.player.inventorySlots,
  );
  expect(game.local.inventory.map((item) => item?.id ?? null)).toEqual([
    "shovel",
    null,
    null,
    null,
  ]);
});

test("the local player holds its selected slot's item, and reports its id", () => {
  const game = session();
  expect(heldItemOf(game, game.local)?.emoji).toBe("🪏");
  expect(playerState(game).content).toMatchObject({
    "core/items": "shovel",
  });
  updateSession(game, { ...idle, select: 1 }, DT);
  expect(heldItemOf(game, game.local)).toBeNull();
  expect(playerState(game).content).toMatchObject({ "core/items": null });
});

test("a remote player holds the item it reports, and nothing for an unknown or no item", () => {
  const game = session();
  const report = (held: string | null) => {
    applyRemoteState(game, {
      id: "them",
      name: "THEM",
      x: 450,
      y: 300,
      aim: 0,
      health: 100,
      content: { "core/items": held },
    });
    const remote = game.players.get("them");
    return remote === undefined ? undefined : heldItemOf(game, remote);
  };
  expect(report("shovel")?.emoji).toBe("🪏");
  expect(report("laser")).toBeNull();
  expect(report(null)).toBeNull();
});

test("the use control swings the held shovel at the step's sim time and sends it to everyone", () => {
  const game = session();
  wait(game, 0.5);
  updateSession(game, swing, DT);
  expect(game.local.use).toMatchObject({
    item: "shovel",
    startedAt: game.time,
  });
  expect(game.outbox).toEqual([
    {
      content: "core/items",
      event: "use",
      route: "all",
      to: null,
      payload: {
        item: "shovel",
        x: game.local.x,
        y: game.local.y,
        aim: game.local.aim,
      },
    },
  ]);
});

test("a swing waits out the cooldown in sim seconds", () => {
  const game = session();
  updateSession(game, swing, DT);
  const first = game.local.use;
  wait(game, shovel.cooldown - 2 * DT);
  updateSession(game, swing, DT);
  expect(game.local.use).toBe(first);
  expect(game.outbox).toHaveLength(1);
  wait(game, DT);
  updateSession(game, swing, DT);
  expect(game.local.use).not.toBe(first);
  expect(game.outbox).toHaveLength(2);
});

test("using an empty hand does nothing", () => {
  const game = session();
  updateSession(game, { ...swing, select: 3 }, DT);
  expect(game.local.use).toBeNull();
  expect(game.outbox).toEqual([]);
});

test("a swing damages what is in its hitbox and knocks it away from the swinger", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  const hit = spawnEntity(game, DUMMY, 500, 300, {});
  const missed = spawnEntity(game, DUMMY, 450, 380, {});

  swingRight(game);
  expect(game.local.use?.hit).toBe(true);
  expect(hit.health).toBe(40 - shovel.damage);
  expect(hit.x).toBeCloseTo(500 + shovel.knockback);
  expect(hit.y).toBeCloseTo(300);
  expect(missed).toMatchObject({ health: 40, x: 450, y: 380 });
});

test("a swing knocks what it hits straight away from the swinger, not from the hitbox's centre", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  const hit = spawnEntity(game, DUMMY, 500, 310, {});

  swingRight(game);
  expect(hit.health).toBe(40 - shovel.damage);
  const away = Math.hypot(50, 10);
  expect(hit.x).toBeCloseTo(500 + (50 / away) * shovel.knockback);
  expect(hit.y).toBeCloseTo(310 + (10 / away) * shovel.knockback);
});

test("a swing that hits nothing shows a miss, and makes no noise", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  swingRight(game);
  expect(game.local.use?.hit).toBe(false);
  expect(game.outbox).toEqual([]);
});

test("a swing that hits sends its noise to everyone, which the host then makes and hears", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  spawnEntity(game, DUMMY, 500, 300, {});
  swingRight(game);
  const center = { x: 450 + shovel.reach, y: 300 };
  expect(game.outbox).toEqual([
    {
      content: "core/noise",
      event: "made",
      route: "all",
      to: null,
      payload: { ...center, loudness: shovel.hitLoudness, source: null },
    },
  ]);
  deliverOwn(game);
  updateSession(game, idle, DT);
  expect(game.noises).toEqual([{ at: center, loudness: shovel.hitLoudness }]);
  const ripples = createRipples(testRippleConfig, mulberry32(1));
  ripples.hear(game, game.time * 1000);
  expect(ripples.list).toEqual([
    expect.objectContaining({ loudness: shovel.hitLoudness }),
  ]);
});

test("a wall in the way stops the knockback but not the damage", () => {
  const game = session();
  standAt(game, { x: 500, y: 500 });
  const pinned = spawnEntity(game, DUMMY, 575, 500, {});
  swingRight(game);
  expect(pinned).toMatchObject({
    health: 40 - shovel.damage,
    x: 575,
    y: 500,
  });
});

test("a swing at the cruiser leaves it whole", () => {
  const game = session();
  for (const content of entityContent(testEntitiesConfig))
    content.register(game);
  standAt(game, { x: 450, y: 300 });
  const cruiser = spawnEntity(game, "cruiser", 500, 300, {});
  swingRight(game);
  expect(game.local.use?.hit).toBe(true);
  expect(cruiser.health).toBe(Infinity);
  updateSession(game, idle, DT);
  expect(game.entities.has(cruiser.id)).toBe(true);
});

test("a swing that kills removes its target", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  const target = spawnEntity(game, DUMMY, 500, 300, {});
  target.health = shovel.damage;
  swingRight(game);
  expect(game.entities.has(target.id)).toBe(false);
});
test("the items config needs the shovel's slice", () => {
  expectTypeOf({}).not.toExtend<ItemsConfig>();
  expectTypeOf(testItemsConfig).toExtend<ItemsConfig>();
});

// Over a room: two clients on a hub that sends every payload through JSON.

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function chaserOf(room: Room): WorldEntity {
  const kind = sessionOf(room).kindIds.get("chaser");
  const found = [...sessionOf(room).entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no chaser");
  return found;
}

/** One blind chaser that stands still. */
const stillChaser = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    wanderSpeed: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 1 },
  },
};

/** Where the guest stands, and the chaser in its swing to the right. */
const GUEST = { x: 150, y: 300 };
const TARGET = { x: GUEST.x + shovel.reach, y: GUEST.y };

/** Two clients joined to one room on the same hub, `a` hosting, the chaser in the guest's swing. */
async function pair() {
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
      content: [...entityContent(stillChaser), ...itemContent(testItemsConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("ITEMS", "A");
  await b.join("ITEMS", "B");
  for (const room of [a, b]) mute(sessionOf(room));
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  /** Runs one step on each client and lets every message through, 200ms later. */
  const exchange = (controls: Controls = idle): void => {
    updateSession(sessionOf(b), controls, DT);
    b.frame(clock.now());
    updateSession(sessionOf(a), idle, DT);
    clock.advance(clock.now() + 200);
    a.frame(clock.now());
    updateSession(sessionOf(b), idle, DT);
  };
  standAt(sessionOf(a), { x: 450, y: 150 });
  standAt(sessionOf(b), GUEST);
  Object.assign(chaserOf(a), { ...TARGET, tx: TARGET.x, ty: TARGET.y });
  exchange();
  exchange();
  return { a, b, clock, exchange };
}

const swingRightOf = (game: Session): Controls => ({
  ...swing,
  aim: { x: game.local.x + 100, y: game.local.y },
});

test("the host applies a guest's swing of the item it holds", async () => {
  const { a, b, exchange } = await pair();
  exchange(swingRightOf(sessionOf(b)));
  expect(chaserOf(a).health).toBe(stillChaser.chaser.maxHealth - shovel.damage);
});

test("a guest that takes out the shovel and swings between ticks is heard holding it", async () => {
  const { a, b, clock, exchange } = await pair();
  exchange({ ...idle, select: 1 });
  b.frame(clock.now());
  const guest = sessionOf(b);
  updateSession(guest, { ...swingRightOf(guest), select: 0 }, DT);
  b.frame(clock.now());
  updateSession(sessionOf(a), idle, DT);
  expect(chaserOf(a).health).toBe(stillChaser.chaser.maxHealth - shovel.damage);
});

test("the host ignores a guest's use of an item it does not hold", async () => {
  const { a, b, exchange } = await pair();
  exchange({ ...idle, select: 1 });
  const guest = sessionOf(b);
  guest.outbox.push({
    content: "core/items",
    event: "use",
    route: "all",
    to: null,
    payload: { item: "shovel", ...guest.local, aim: 0 },
  });
  exchange();
  const host = sessionOf(a);
  expect(chaserOf(a).health).toBe(stillChaser.chaser.maxHealth);
  expect(host.players.get("b")?.use).toBeNull();
  expect(host.noises).toEqual([]);
});
