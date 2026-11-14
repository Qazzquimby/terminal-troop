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
  giveItem,
  heldItemOf,
  heldSlot,
  mulberry32,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import { createSession, PLAYER_TAG } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { teleport } from "./crew.js";
import { heardAt } from "./heard.js";
import {
  createHub,
  createManualClock,
  forgeAction,
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
  drop: false,
  holdingUse: false,
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
    expect(heldSlot.get(game.local)).toBeNull();
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

test("the local player holds its selected slot's item, and its step holds the slot for the host to send", () => {
  const game = session();
  expect(heldItemOf(game, game.local)?.emoji).toBe("🪏");
  updateSession(game, idle, DT);
  expect(heldSlot.get(game.local)).toBe(0);
  updateSession(game, { ...idle, select: 1 }, DT);
  expect(heldItemOf(game, game.local)).toBeNull();
  expect(heldSlot.get(game.local)).toBe(1);
});

test("a remote player holds what the host's record has in the slot the host says it holds, and nothing for an empty or no slot", () => {
  const game = session();
  giveItem(game, "them", "scrap", 2);
  const report = (held: number | null) =>
    heldItemOf(
      game,
      heardAt(
        game,
        "them",
        { x: 450, y: 300 },
        {
          content: { "core/items": held },
        },
      ),
    );
  expect(report(0)?.emoji).toBe("🪏");
  expect(report(2)?.id).toBe("scrap");
  expect(report(1)).toBeNull();
  expect(report(null)).toBeNull();
});

test("a guest's use control swings the held shovel at the step's sim time and sends it to the host, stamped with the step", () => {
  const game = session();
  game.hosting = false;
  wait(game, 0.5);
  game.outbox.length = 0;
  updateSession(game, swing, DT);
  expect(game.local.use).toMatchObject({
    item: "shovel",
    startedAt: game.time,
  });
  expect(game.outbox).toEqual([
    {
      content: "item/shovel",
      event: "use",
      route: "host",
      to: null,
      payload: {
        action: 1,
        step: game.step,
        input: { slot: 0, aim: game.local.aim },
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

test("a swing that hits nothing shows a miss, and makes only the short noise of its sound", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  swingRight(game);
  expect(game.local.use?.hit).toBe(false);
  expect(game.noises).toEqual([
    {
      at: { x: 450 + shovel.reach, y: 300 },
      radius: shovel.missNoiseRadius,
      source: "me",
      tags: [PLAYER_TAG],
    },
  ]);
  updateSession(game, idle, DT);
  expect(game.noises).toEqual([]);
});

test("a swing that hits sends its noise to everyone, which the host then makes and hears", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  spawnEntity(game, DUMMY, 500, 300, {});
  updateSession(game, { ...swing, aim: { x: 550, y: 300 } }, DT);
  const center = { x: 450 + shovel.reach, y: 300 };
  expect(game.outbox).toEqual([
    expect.objectContaining({ content: "core/actions", route: "all" }),
  ]);
  deliverOwn(game);
  updateSession(game, idle, DT);
  expect(game.noises).toEqual([
    {
      at: center,
      radius: shovel.hitNoiseRadius,
      source: "me",
      tags: [PLAYER_TAG],
    },
  ]);
  const ripples = createRipples(testRippleConfig, mulberry32(1));
  ripples.hear(game, game.time * 1000);
  expect(ripples.list).toEqual([
    expect.objectContaining({ radius: shovel.hitNoiseRadius }),
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
  const cruiser = spawnEntity(game, "cruiser", 500, 300, {
    fuel: 0,
    damage: 0,
    heading: 0,
  });
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

function zombieOf(room: Room): WorldEntity {
  const kind = sessionOf(room).kindIds.get("zombie");
  const found = [...sessionOf(room).entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no zombie");
  return found;
}

/** One blind zombie that stands still. */
const stillZombie = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    sightRange: 0,
    wanderSpeed: 0,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 1 },
  },
};

/** Where the guest stands, and the zombie in its swing to the right. */
const GUEST = { x: 150, y: 300 };
const TARGET = { x: GUEST.x + shovel.reach, y: GUEST.y };

/** Two clients joined to one room on the same hub, `a` hosting, the zombie in the guest's swing. */
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
      content: [...entityContent(stillZombie), ...itemContent(testItemsConfig)],
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
  /**
   * Runs both clients a third of a second, step for step, each sending as it ticks: long enough
   * for the host's run of the guest, which trails the guest's own, to take in what it sent.
   */
  const hostCatchesUp = (): void => {
    for (let step = 0; step < 20; step++)
      for (const room of [a, b]) {
        updateSession(sessionOf(room), idle, DT);
        clock.advance(clock.now() + 1000 * (DT / 2));
        room.frame(clock.now());
      }
  };
  /** Runs one step of the guest on `controls` and sends it, then lets both run on. */
  const exchange = (controls: Controls = idle): void => {
    updateSession(sessionOf(b), controls, DT);
    b.frame(clock.now());
    hostCatchesUp();
  };
  const games = [sessionOf(a), sessionOf(b)];
  teleport(games, "a", { x: 450, y: 150 });
  teleport(games, "b", GUEST);
  Object.assign(zombieOf(a), { ...TARGET, tx: TARGET.x, ty: TARGET.y });
  for (let round = 0; round < 4; round++) exchange();
  expect(sessionOf(b).local).toMatchObject(GUEST);
  return { a, b, clock, exchange, hostCatchesUp };
}

const swingRightOf = (game: Session): Controls => ({
  ...swing,
  aim: { x: game.local.x + 100, y: game.local.y },
});

test("the host applies a guest's swing of the item it holds", async () => {
  const { a, b, exchange } = await pair();
  exchange(swingRightOf(sessionOf(b)));
  expect(zombieOf(a).health).toBe(stillZombie.zombie.maxHealth - shovel.damage);
});

test("a guest that takes out the shovel and swings between ticks is heard holding it", async () => {
  const { a, b, clock, exchange, hostCatchesUp } = await pair();
  exchange({ ...idle, select: 1 });
  const guest = sessionOf(b);
  updateSession(guest, { ...swingRightOf(guest), select: 0 }, DT);
  b.frame(clock.now());
  hostCatchesUp();
  expect(zombieOf(a).health).toBe(stillZombie.zombie.maxHealth - shovel.damage);
});

test("the host ignores a guest's use of an item its record does not have in the slot named", async () => {
  const { a, b, exchange } = await pair();
  exchange({ ...idle, select: 1 });
  const guest = sessionOf(b);
  forgeAction(guest, "item/shovel.use", { slot: 1, aim: 0 });
  exchange();
  const host = sessionOf(a);
  expect(zombieOf(a).health).toBe(stillZombie.zombie.maxHealth);
  expect(host.players.get("b")?.use).toBeNull();
  expect(host.noises).toEqual([]);
});
