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
import { createPlayer } from "./player.js";
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
