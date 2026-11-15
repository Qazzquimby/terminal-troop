import { expect, test, vi } from "vitest";
import { z } from "zod";
import { reportedAt } from "../integration/heard.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { defineAction } from "./actions.js";
import { registerContent } from "./content.js";
import type { WorldContent } from "./content.js";
import { receiveEvent } from "./content-event.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { createSession, removePlayer, updateSession } from "./session.js";
import { bodyStatuses, isStunned, stun } from "./status.js";
import { applyWorldEntries, takeWorldEntries } from "./world-data.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};

/** A dev-square session whose one kind counts its updates and walks right at 60px/s. */
function session(localId = "me"): Session {
  const game = createSession(
    localId,
    "ME",
    "STUN",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 600, y: 450 });
  registerEntityType(game, "walker", {
    radius: 10,
    maxHealth: 10,
    data: z.object({ steps: z.number().int() }),
    update(entity, data) {
      entity.vx = 60;
      return { steps: data.steps + 1 };
    },
    strikes: () => [{ target: "me", amount: 1 }],
    draw: () => undefined,
  });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

test("a stunned entity of any kind neither runs, moves nor strikes until the stun ends", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  const health = game.local.health;
  expect(stun(game, walker.id, 1)).toBe(true);

  run(game, 0.5);
  expect(isStunned(game, walker.id)).toBe(true);
  expect(walker.data).toEqual({ steps: 0 });
  expect(walker.x).toBe(100);
  expect(game.local.health).toBe(health);

  run(game, 0.6);
  expect(isStunned(game, walker.id)).toBe(false);
  expect(
    z.object({ steps: z.number() }).parse(walker.data).steps,
  ).toBeGreaterThan(0);
  expect(walker.x).toBeGreaterThan(100);
  expect(game.local.health).toBeLessThan(health);
});

test("stunning again lengthens a stun but never shortens it", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  stun(game, walker.id, 2);
  stun(game, walker.id, 1);
  run(game, 1.5);
  expect(isStunned(game, walker.id)).toBe(true);
  stun(game, walker.id, 1);
  run(game, 0.8);
  expect(isStunned(game, walker.id)).toBe(true);
  run(game, 0.3);
  expect(isStunned(game, walker.id)).toBe(false);
});

test("ended stuns, and those of entities gone, are forgotten", () => {
  const game = session();
  const walker = spawnEntity(game, "walker", 100, 100, { steps: 0 });
  const other = spawnEntity(game, "walker", 300, 100, { steps: 0 });
  stun(game, walker.id, 0.1);
  stun(game, other.id, 10);
  game.entities.delete(other.id);
  run(game, 0.2);
  expect(bodyStatuses.get(game)).toEqual({});
});

test("only the host stuns, and every client holds who is stunned", () => {
  const host = session("me");
  const guest = session("you");
  guest.hosting = false;
  const walker = spawnEntity(host, "walker", 100, 100, { steps: 0 });
  spawnEntity(guest, "walker", 100, 100, { steps: 0 });

  expect(stun(guest, walker.id, 5)).toBe(false);
  expect(stun(host, walker.id, 5)).toBe(true);
  const entries = takeWorldEntries(host, false);
  expect(entries).not.toBeNull();
  applyWorldEntries(guest, { host: "me", term: 1 }, entries ?? {});
  expect(isStunned(guest, walker.id)).toBe(true);
});

// Players are bodies like any other: a stun holds them too.

/** Every poke the host has applied, by whom. */
const pokes: string[] = [];

/** An action that does nothing but count itself, on the host. */
const poke = defineAction("poke", {
  input: z.object({}),
  apply(game, actor) {
    if (game.hosting) pokes.push(actor.id);
  },
});

const POKE: WorldContent = {
  name: "move/poke",
  actions: [poke],
  register: () => undefined,
  populate: () => undefined,
};

/** Hands the host remote player `g`'s steer, starting on its step `step`. */
function steer(game: Session, step: number, move: { x: number; y: number }) {
  receiveEvent(
    game,
    {
      from: "g",
      to: null,
      content: "core/steering",
      event: "steer",
      payload: { step, move, sprint: false, held: null },
    },
    game.localId,
  );
}

/** Hands the host remote player `g`'s poke, made in its step `step`. */
function pokeFrom(game: Session, step: number, action: number): void {
  receiveEvent(
    game,
    {
      from: "g",
      to: null,
      content: "move/poke",
      event: "poke",
      payload: { action, step, input: {} },
    },
    game.localId,
  );
}

/** A host with the poke, and a remote player `g` at (300, 300). */
function hostWithGuest(): { game: Session; guest: Player } {
  const game = session("me");
  registerContent(game, [POKE]);
  return { game, guest: reportedAt(game, "g", { x: 300, y: 300 }) };
}

test("on the host, a stunned player neither moves nor acts until the stun ends", () => {
  pokes.length = 0;
  const { game, guest } = hostWithGuest();
  steer(game, 1, { x: 1, y: 0 });
  run(game, 0.3);
  expect(guest.x).toBeGreaterThan(300);

  expect(stun(game, "g", 1)).toBe(true);
  run(game, 0.3);
  const stopped = guest.x;
  run(game, 0.3);
  expect(guest.x).toBeCloseTo(stopped);
  pokeFrom(game, game.feeds.get("g")?.label ?? 0, 1);
  run(game, 0.2);
  expect(pokes).toEqual([]);

  run(game, 0.5);
  expect(isStunned(game, "g")).toBe(false);
  expect(guest.x).toBeGreaterThan(stopped);
  pokeFrom(game, game.feeds.get("g")?.label ?? 0, 2);
  run(game, 0.2);
  expect(pokes).toEqual(["g"]);
});

/** A guest `g` with the poke, and the host `me` that runs it, holding it at (300, 300). */
function guestAndHost(): { guest: Session; host: Session } {
  const host = session("me");
  registerContent(host, [POKE]);
  reportedAt(host, "g", { x: 300, y: 300 });
  const guest = session("g");
  guest.hosting = false;
  registerContent(guest, [POKE]);
  Object.assign(guest.local, { x: 300, y: 300, prevX: 300, prevY: 300 });
  return { guest, host };
}

/** Hands `guest` the host's world entries, as its snapshots do. */
function hearHost(host: Session, guest: Session): void {
  const entries = takeWorldEntries(host, false);
  applyWorldEntries(guest, { host: "me", term: 1 }, entries ?? {});
}

test("a stunned guest predicts standing still and acting not, then goes on once the stun ends", () => {
  const { guest, host } = guestAndHost();
  const walk = { ...idle, move: { x: 1, y: 0 } };
  expect(stun(host, "g", 1)).toBe(true);
  hearHost(host, guest);
  expect(isStunned(guest, "g")).toBe(true);

  for (let step = 0; step < 30; step++) updateSession(guest, walk, DT);
  expect(guest.local.x).toBe(300);
  expect(poke.perform(guest, {})).toBe(false);

  for (let step = 0; step < 42; step++) updateSession(guest, walk, DT);
  expect(isStunned(guest, "g")).toBe(false);
  expect(guest.local.x).toBeGreaterThan(300);
  expect(poke.perform(guest, {})).toBe(true);
});

test("every client sees a player's stun, its own and others'", () => {
  const { guest, host } = guestAndHost();
  stun(host, "me", 2);
  stun(host, "g", 2);
  hearHost(host, guest);
  expect(isStunned(guest, "me")).toBe(true);
  expect(isStunned(guest, "g")).toBe(true);
});

test("a player's stun is kept while it lasts and forgotten as it ends or the player leaves", () => {
  const { game } = hostWithGuest();
  stun(game, "me", 0.5);
  stun(game, "g", 10);
  run(game, 0.2);
  expect(Object.keys(bodyStatuses.get(game)).sort()).toEqual(["g", "me"]);
  run(game, 0.4);
  expect(Object.keys(bodyStatuses.get(game))).toEqual(["g"]);
  removePlayer(game, "g");
  run(game, DT);
  expect(bodyStatuses.get(game)).toEqual({});
});

test("only a body in the world can be stunned: not one unknown, nor a ghost", () => {
  const game = session();
  expect(stun(game, "nobody", 1)).toBe(false);
  game.local.health = 0;
  expect(stun(game, "me", 1)).toBe(false);
});

test("a stunned local player's ears ring until the stun ends", () => {
  const game = session();
  const loop = vi.spyOn(game.sfx, "playLoop");
  const stop = vi.spyOn(game.sfx, "stop");
  stun(game, "me", 0.5);
  run(game, 0.2);
  expect(loop).toHaveBeenCalledTimes(1);
  expect(loop.mock.calls[0]?.[1]).toMatch(/stunned-ring\.mp3$/);
  expect(stop).not.toHaveBeenCalled();
  run(game, 0.4);
  expect(stop).toHaveBeenCalledWith(
    loop.mock.calls[0]?.[0],
    testSimConfig.stunned.ring.fadeSeconds,
  );
});
