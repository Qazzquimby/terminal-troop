import { expect, test, vi } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  dash,
  defineAction,
  effect,
  hurt,
  push,
  receiveEvent,
  registerContent,
  registerEntityType,
  sound,
  spawnEntity,
} from "./index.js";
import type { Action, WorldContent, WorldEntity } from "./index.js";
import { changeWorld, give, removeFromWorld, spawn, take } from "./actions.js";
import { giveItem, inventories, itemIn, takeItem } from "./inventories.js";
import { createPlayer } from "./player.js";
import { registerItem } from "./use.js";
import { worldData } from "./world-data.js";
import type { Session } from "./session.js";
import { createSession } from "./session.js";

const BONK = sound({ url: "bonk.mp3" });
const Target = z.object({ target: z.string() });

/** Hurts and shoves the named entity or player away from the actor, dashing the actor ahead. */
const bonk = defineAction("bonk", {
  input: Target,
  apply(game, actor, { target }) {
    const body = game.entities.get(target) ?? game.players.get(target);
    if (body === undefined) return;
    dash(game, actor, { aim: 0, distance: 20, seconds: 0.1 });
    hurt(game, body, 5);
    push(game, body, actor, 30);
    effect(game, {
      at: { x: body.x, y: body.y },
      sound: BONK,
      flash: { radius: 10, hit: true },
      noise: 200,
    });
  },
});

const entry = (actions: readonly Action<never>[]): WorldContent => ({
  name: "move/bonk",
  actions,
  register(game) {
    registerEntityType(game, "post", {
      radius: 10,
      maxHealth: 50,
      data: z.object({}),
      draw: () => undefined,
    });
  },
  populate: () => undefined,
});

/** A session with the bonk, its player at (100, 100), a post to its right, and a muted, counted sfx. */
function session() {
  const game = createSession(
    "me",
    "ME",
    "BONK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  const play = vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [entry([bonk])]);
  Object.assign(game.local, { x: 100, y: 100 });
  const post = spawnEntity(game, "post", 150, 100, {});
  return { game, play, post };
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

/** Applies the events delivered to `game`, as its next step does. */
function receive(game: Session): void {
  for (const { event, payload, sender } of game.inbox.splice(0))
    event.receive(game, payload, sender);
}

const at = (entity: WorldEntity) => ({ x: entity.x, y: entity.y });

test("a host acting itself changes nothing until its request comes back, then applies it once", () => {
  const { game, play, post } = session();
  expect(bonk.perform(game, { target: post.id })).toBe(true);
  expect(post.health).toBe(50);
  expect(at(post)).toEqual({ x: 150, y: 100 });
  expect(game.local.dash).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
  expect(game.flashes).toHaveLength(1);
  expect(game.outbox.map(({ event }) => event)).toEqual(["bonk"]);

  deliverOwn(game);
  receive(game);
  expect(post.health).toBe(45);
  expect(post.x).toBeCloseTo(180);
  expect(game.outbox.map(({ event }) => event)).toEqual(["effects"]);

  deliverOwn(game);
  game.flashes.length = 0;
  receive(game);
  expect(play).toHaveBeenCalledTimes(1);
  expect(game.flashes).toEqual([]);
  expect(game.noises).toEqual([
    { at: { x: post.x, y: post.y }, radius: 200, source: "me" },
  ]);
});

test("a guest acting predicts what it does to world entities, held, and leaves players to the host", () => {
  const { game, post } = session();
  const other = createPlayer("them", "THEM", { x: 100, y: 160 }, testSimConfig);
  game.players.set(other.id, other);
  game.hosting = false;
  bonk.perform(game, { target: post.id });
  expect(post.health).toBe(45);
  expect(post.x).toBeCloseTo(180);
  expect(game.predictions.get(post.id)).toMatchObject({
    action: 1,
    health: 50,
  });
  bonk.perform(game, { target: other.id });
  expect(other.health).toBe(other.maxHealth);
  expect({ x: other.x, y: other.y }).toEqual({ x: 100, y: 160 });
  expect(game.forcedSeen.size).toBe(0);
});

test("an effect outside an action is an error", () => {
  const { game } = session();
  expect(() => {
    effect(game, { at: { x: 0, y: 0 } });
  }).toThrow();
});

test("an action unregistered, or registered under a name taken, is an error", () => {
  const game = createSession(
    "me",
    "ME",
    "BONK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  expect(() => bonk.perform(game, { target: "x" })).toThrow();
  const again = defineAction("bonk", { input: Target, apply: () => undefined });
  expect(() => {
    registerContent(game, [entry([bonk, again])]);
  }).toThrow();
});

test("a cooldown and stamina cost hold back the actor's own client", () => {
  const { game, post } = session();
  const costly = defineAction("costly", {
    input: Target,
    cooldown: 1,
    stamina: 40,
    apply: () => undefined,
  });
  registerContent(game, [
    { ...entry([costly]), name: "move/costly", register: () => undefined },
  ]);
  const full = game.local.stamina.value;
  expect(costly.perform(game, { target: post.id })).toBe(true);
  expect(game.local.stamina.value).toBe(full - 40);
  expect(costly.perform(game, { target: post.id })).toBe(false);
  game.localReadyAt.clear();
  game.local.stamina = { ...game.local.stamina, value: 39 };
  expect(costly.perform(game, { target: post.id })).toBe(false);
  expect(game.lastAction).toBe(1);
});

// Items and what only the host changes.

/** How many trades the host has made. */
const traded = worldData({ schema: z.number().int().min(0), initial: 0 });

const PEBBLE = { id: "pebble", name: "Pebble", emoji: "🪨" };

/**
 * A trade: with `pick`, takes that post out of the world and gives the actor a pebble; otherwise
 * takes the item out of `slot`, puts a post where the actor stands and counts the trade.
 */
const trade = defineAction("trade", {
  input: z.object({ slot: z.number().int(), pick: z.string().optional() }),
  cooldown: (game) => game.config.worldItems.cooldown,
  apply(game, actor, { slot, pick }) {
    if (pick !== undefined) {
      const entity = game.entities.get(pick);
      if (entity === undefined) return;
      removeFromWorld(game, entity);
      give(game, actor, PEBBLE.id);
      return;
    }
    if (take(game, actor, slot) === null) return;
    spawn(game, "post", { x: actor.x, y: actor.y }, {});
    changeWorld(game, traded, (count) => count + 1);
  },
});

/** The session, with the trade, a pebble its player holds in the first slot, and the post. */
function trading() {
  const game = createSession(
    "me",
    "ME",
    "TRADE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    { ...entry([trade]), name: "move/trade", world: { traded } },
  ]);
  registerItem(game, PEBBLE);
  game.local.inventory[0] = PEBBLE;
  expect(giveItem(game, game.localId, PEBBLE.id, 0)).toBe(true);
  Object.assign(game.local, { x: 100, y: 100 });
  const post = spawnEntity(game, "post", 150, 100, {});
  return { game, post };
}

const posts = (game: Session): number => game.entities.size;
const carried = (game: Session) =>
  game.local.inventory.map((item) => item?.id ?? null);

test("a guest's trade shows in its items at once, held, and changes nothing only the host changes", () => {
  const { game, post } = trading();
  game.hosting = false;
  trade.perform(game, { slot: 0 });
  expect(carried(game)).toEqual([null, null, null, null]);
  expect(game.inventoryHold).toMatchObject({ action: 1, reaching: [] });
  expect(posts(game)).toBe(1);
  expect(traded.get(game)).toBe(0);
  expect(itemIn(game, game.localId, 0)).toBe(PEBBLE.id);
  game.localReadyAt.clear();
  trade.perform(game, { slot: 0, pick: post.id });
  expect(carried(game)).toEqual([PEBBLE.id, null, null, null]);
  expect(game.inventoryHold).toMatchObject({ action: 2, reaching: [post.id] });
  expect(game.entities.has(post.id)).toBe(true);
  expect(game.outbox.map(({ payload }) => payload)).toEqual([
    { action: 1, input: { slot: 0 }, items: true },
    { action: 2, input: { slot: 0, pick: post.id }, items: true },
  ]);
});

test("a host's own trade shows in its items at once, and changes the host's record and the world once, as it applies it", () => {
  const { game, post } = trading();
  trade.perform(game, { slot: 0 });
  expect(carried(game)).toEqual([null, null, null, null]);
  expect(itemIn(game, game.localId, 0)).toBe(PEBBLE.id);
  expect(posts(game)).toBe(1);
  expect(traded.get(game)).toBe(0);
  deliverOwn(game);
  receive(game);
  expect(itemIn(game, game.localId, 0)).toBeNull();
  expect(posts(game)).toBe(2);
  expect(traded.get(game)).toBe(1);

  game.time += 1;
  trade.perform(game, { slot: 0, pick: post.id });
  expect(carried(game)).toEqual([PEBBLE.id, null, null, null]);
  expect(game.entities.has(post.id)).toBe(true);
  deliverOwn(game);
  receive(game);
  expect(game.entities.has(post.id)).toBe(false);
  expect(itemIn(game, game.localId, 0)).toBe(PEBBLE.id);
});

test("the host refuses a trade of an empty slot: its record and the world stay as they were, and the actor's items go out again", () => {
  const { game } = trading();
  takeItem(game, game.localId, 0, PEBBLE.id);
  game.worldChanged.clear();
  trade.perform(game, { slot: 0 });
  deliverOwn(game);
  receive(game);
  expect(posts(game)).toBe(1);
  expect(traded.get(game)).toBe(0);
  expect(game.worldChanged.has(inventories)).toBe(true);
});

test("an action's cooldown may come from the session's config", () => {
  const { game } = trading();
  trade.perform(game, { slot: 1 });
  expect(game.localReadyAt.get("move/trade.trade")).toBe(
    game.time + testSimConfig.worldItems.cooldown,
  );
  expect(trade.perform(game, { slot: 1 })).toBe(false);
});

test("an effect's use shows on the actor: on its own client as it acts, on every other once the host sends it", () => {
  const show = defineAction("show", {
    input: z.object({}),
    apply(game) {
      effect(game, { at: { x: 7, y: 8 }, use: { item: "pebble", hit: true } });
    },
  });
  const { game } = session();
  registerContent(game, [
    { ...entry([show]), name: "move/show", register: () => undefined },
  ]);
  const other = createPlayer("them", "THEM", { x: 0, y: 0 }, testSimConfig);
  game.players.set(other.id, other);
  show.perform(game, {});
  const use = { item: "pebble", center: { x: 7, y: 8 }, hit: true };
  expect(game.local.use).toEqual({ ...use, startedAt: game.time });
  game.local.use = null;
  receiveEvent(
    game,
    {
      from: "them",
      to: null,
      content: "move/show",
      event: "show",
      payload: { action: 1, input: {} },
    },
    game.localId,
  );
  receive(game);
  deliverOwn(game);
  receive(game);
  expect(other.use).toEqual({ ...use, startedAt: game.time });
  expect(game.local.use).toBeNull();
});
