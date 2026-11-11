import { expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  applyRemoteState,
  heldItemOf,
  playerState,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import { createSession } from "../sim/index.js";
import type { Controls, Point, Session } from "../sim/index.js";
import {
  testEntitiesConfig,
  testSfx,
  testItemsConfig,
  testSimConfig,
} from "./sim-config.js";

const { shovel } = testItemsConfig;
const DT = 1 / 60;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  select: null,
  use: false,
};
const swing: Controls = { ...idle, use: true };

/** A kind that stands still with 40 health. */
const DUMMY = "dummy";

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
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
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

test("the inventory has the configured slots, the shovel in the first", () => {
  const game = session();
  expect(game.local.inventory).toHaveLength(
    testSimConfig.player.inventorySlots,
  );
  expect(game.local.inventory.map((stack) => stack?.item.id ?? null)).toEqual([
    "shovel",
    null,
    null,
    null,
  ]);
});

test("the local player holds its selected slot's item, and reports its id", () => {
  const game = session();
  expect(heldItemOf(game, game.local)?.emoji).toBe("🪏");
  expect(playerState(game).content).toEqual({ "core/items": "shovel" });
  updateSession(game, { ...idle, select: 1 }, DT);
  expect(heldItemOf(game, game.local)).toBeNull();
  expect(playerState(game).content).toEqual({ "core/items": null });
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

test("selecting a slot past the last keeps the held one", () => {
  const game = session();
  updateSession(game, { ...idle, select: 2 }, DT);
  updateSession(
    game,
    { ...idle, select: testSimConfig.player.inventorySlots },
    DT,
  );
  expect(game.local.held).toBe(2);
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

test("a swing damages what is in its hitbox and knocks it away from the hitbox's centre", () => {
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

test("a swing that hits nothing shows a miss", () => {
  const game = session();
  standAt(game, { x: 450, y: 300 });
  swingRight(game);
  expect(game.local.use?.hit).toBe(false);
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
