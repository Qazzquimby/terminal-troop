import { expect, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { createFlashes } from "../render/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  applyRemoteState,
  createSession,
  isAreaFree,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testFlashConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const { kick } = testMovesConfig;
const DT = 1 / 60;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
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

/** A kind that stands still with 40 health and a radius of 15. */
const DUMMY = "dummy";
const DUMMY_LENGTH = 30;

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

/** Kicks facing right of where `game`'s local player stands. */
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

/** A dev-square session with the test moves and the dummy kind registered, sound muted. */
function session(): Session {
  const game = createSession(
    "me",
    "ME",
    "KICK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, moveContent(testMovesConfig));
  registerEntityType(game, DUMMY, {
    radius: 15,
    maxHealth: 40,
    data: z.object({}),
    update: (_entity, data) => data,
    draw: () => undefined,
  });
  return game;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** Steps `game` `seconds` with `controls`. */
function wait(game: Session, seconds: number, controls = idle): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, controls, DT);
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

/** Kicks right, and hands the kick to the session's host step as the room would. */
function kickOnce(game: Session): void {
  updateSession(game, kickRight(game), DT);
  deliverOwn(game);
  updateSession(game, idle, DT);
}

/** Where the kick's hitbox lands for a kicker at `at` facing right, once it has lunged. */
const hitboxRightOf = (at: Point): Point => ({
  x: at.x + PLAYER_LENGTH + kick.reach,
  y: at.y,
});

test("a kick lunges the kicker one body length, spends its stamina and goes to the host", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  updateSession(game, kickRight(game), DT);
  expect(game.local.stamina.value).toBe(
    testSimConfig.stamina.max - kick.stamina,
  );
  expect(game.outbox).toEqual([
    {
      content: "move/kick",
      event: "kicked",
      route: "host",
      to: null,
      payload: { x: 300 + PLAYER_LENGTH, y: 300, aim: 0, action: 1 },
    },
  ]);
  wait(game, kick.lunge.seconds + DT);
  expect(game.local.x).toBeCloseTo(300 + PLAYER_LENGTH);
  expect(game.local.y).toBeCloseTo(300);
});

test("the lunge stops at a wall", () => {
  const game = session();
  const wall = game.world.W;
  standAt(game, { x: wall - 20, y: 300 });
  updateSession(game, kickRight(game), DT);
  wait(game, kick.lunge.seconds + DT);
  expect(game.local.x).toBeCloseTo(wall - testSimConfig.player.radius);
});

test("without the stamina for it, there is no kick: no lunge, nothing sent", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  game.local.stamina = { value: kick.stamina - 1, exhausted: false, rested: 0 };
  updateSession(game, kickRight(game), DT);
  expect(game.outbox).toEqual([]);
  expect(game.flashes).toEqual([]);
  expect(game.local.dash).toBeNull();
  expect(game.local.stamina.value).toBe(kick.stamina - 1);
});

test("kicking something close by, the lunge stops at it and the kick lands on it", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  const touching = testSimConfig.player.radius + DUMMY_LENGTH / 2;
  const target = spawnEntity(game, DUMMY, 300 + touching + 2, 300, {});
  updateSession(game, kickRight(game), DT);
  expect(game.flashes).toHaveLength(1);
  expect(game.flashes[0]?.at.x).toBeCloseTo(300 + 2 + kick.reach);
  expect(Math.abs((game.flashes[0]?.at.x ?? 0) - target.x)).toBeLessThan(5);
  expect(game.outbox[0]?.payload).toMatchObject({ x: 302, y: 300 });
});

test("the lunge never runs into a player in the way", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    x: 340,
    y: 300,
    aim: 0,
    health: 100,
    content: {},
  });
  updateSession(game, kickRight(game), DT);
  const reached: number[] = [];
  for (let step = 0; step < 10; step++) {
    updateSession(game, idle, DT);
    reached.push(game.local.x);
  }
  expect(Math.max(...reached)).toBeCloseTo(340 - PLAYER_LENGTH);
});

test("kicking something close by, the lunge carries on once it is knocked away", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  const touching = testSimConfig.player.radius + DUMMY_LENGTH / 2;
  spawnEntity(game, DUMMY, 300 + touching + 1, 300, {});
  kickOnce(game);
  wait(game, kick.lunge.seconds);
  expect(game.local.x - 300).toBeGreaterThan(PLAYER_LENGTH * 0.6);
});

test("a kick hurts what it hits and knocks it its configured body lengths from the kicker", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  const at = hitboxRightOf(game.local);
  const hit = spawnEntity(game, DUMMY, at.x, at.y, {});
  kickOnce(game);
  expect(hit.health).toBe(40 - kick.damage);
  const pushed = hit.x - at.x;
  expect(pushed).toBeGreaterThan(DUMMY_LENGTH * kick.knockback - 5);
  expect(pushed).toBeLessThanOrEqual(DUMMY_LENGTH * kick.knockback);
  expect(hit.y).toBeCloseTo(300);
});

test("a kick that knocks something into a wall stops it there, still hurt", () => {
  const game = session();
  const wall = game.world.W;
  standAt(game, { x: wall - 90, y: 300 });
  const at = { x: wall - 40, y: 300 };
  const hit = spawnEntity(game, DUMMY, at.x, at.y, {});
  kickOnce(game);
  expect(hit.health).toBe(40 - kick.damage);
  expect(hit.x).toBeGreaterThan(at.x);
  expect(hit.x).toBeLessThanOrEqual(wall - 15);
});

test("enough kicks fell a chaser", () => {
  const game = session();
  for (const content of entityContent(entities)) {
    content.register(game);
    content.populate(game);
  }
  const [chaser] = game.entities.values();
  if (chaser === undefined) throw new Error("no chaser");
  const needed = Math.ceil(testEntitiesConfig.chaser.maxHealth / kick.damage);
  for (let count = 1; count <= needed; count++) {
    standAt(game, { x: 200, y: 300 });
    Object.assign(chaser, hitboxRightOf(game.local));
    game.local.stamina = { value: kick.stamina, exhausted: false, rested: 0 };
    kickOnce(game);
    expect(chaser.health).toBe(
      Math.max(0, testEntitiesConfig.chaser.maxHealth - count * kick.damage),
    );
    wait(game, kick.cooldown);
  }
  expect(game.entities.has(chaser.id)).toBe(false);
});

test("a kick waits out its cooldown on the kicker's client", () => {
  const game = session();
  standAt(game, { x: 300, y: 300 });
  updateSession(game, kickRight(game), DT);
  game.outbox.length = 0;
  wait(game, kick.cooldown - 2 * DT, kickRight(game));
  expect(game.outbox).toEqual([]);
  wait(game, 3 * DT, kickRight(game));
  expect(game.outbox).toHaveLength(1);
});

// Over a room: two clients on a hub that sends every payload through JSON.

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function chaserOf(room: Room): WorldEntity {
  const [chaser] = sessionOf(room).entities.values();
  if (chaser === undefined) throw new Error("no chaser");
  return chaser;
}

/** Two clients joined to one room on the same hub, `a` hosting. */
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
      content: [...entityContent(entities), ...moveContent(testMovesConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("KICK", "A");
  await b.join("KICK", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  /** What each client draws of the blows it sees land, as its frames would. */
  const seen = {
    a: createFlashes(testFlashConfig),
    b: createFlashes(testFlashConfig),
  };
  const step = (room: Room, controls: Controls): void => {
    updateSession(sessionOf(room), controls, DT);
    seen[room === a ? "a" : "b"].see(sessionOf(room), clock.now());
  };
  /** Runs one step on each client and lets every message through, 200ms later. */
  const exchange = (controls: { a?: Controls; b?: Controls } = {}): void => {
    step(b, controls.b ?? idle);
    b.frame(clock.now());
    step(a, controls.a ?? idle);
    clock.advance(clock.now() + 200);
    a.frame(clock.now());
    step(b, idle);
  };
  return { a, b, clock, exchange, seen, step };
}

/** Puts `room`'s local player at `at`, still. */
function place(room: Room, at: Point): void {
  standAt(sessionOf(room), at);
}

/** Two clear spots side by side in the dev square, the guest's left of the chaser. */
const GUEST = { x: 150, y: 300 };
const TARGET = hitboxRightOf(GUEST);

/** The guest at GUEST and the chaser in its kick's hitbox, as the host knows them. */
async function lineUp() {
  const room = await pair();
  const { a, b, exchange } = room;
  place(a, { x: 450, y: 150 });
  place(b, GUEST);
  Object.assign(chaserOf(a), { ...TARGET, tx: TARGET.x, ty: TARGET.y });
  exchange();
  exchange();
  expect(isAreaFree(sessionOf(a).world.map, TARGET.x, TARGET.y, 15)).toBe(true);
  return room;
}

test("a guest's kick hurts and knocks back on the host, and both clients see it", async () => {
  const { a, b, exchange, seen, step } = await lineUp();
  const guest = sessionOf(b);
  exchange({ b: kickRight(guest) });

  const onHost = chaserOf(a);
  expect(onHost.health).toBe(entities.chaser.maxHealth - kick.damage);
  expect(onHost.x - TARGET.x).toBeGreaterThan(
    DUMMY_LENGTH * kick.knockback - 5,
  );
  expect(chaserOf(b)).toMatchObject({ health: onHost.health, tx: onHost.x });
  step(a, idle);
  const flash = { at: TARGET, radius: kick.radius, hit: true };
  expect(seen.a.list).toEqual([expect.objectContaining(flash)]);
  expect(seen.b.list).toEqual([expect.objectContaining(flash)]);
});

test("the host turns down a kick still on cooldown, however the guest's client counts", async () => {
  const { a, b, exchange } = await lineUp();
  const guest = sessionOf(b);
  exchange({ b: kickRight(guest) });
  Object.assign(chaserOf(a), { ...TARGET, tx: TARGET.x, ty: TARGET.y });
  guest.localReadyAt.clear();
  place(b, GUEST);
  exchange({ b: kickRight(guest) });
  expect(chaserOf(a).health).toBe(entities.chaser.maxHealth - kick.damage);
});

test("a guest without the stamina sends no kick", async () => {
  const { a, b, exchange } = await lineUp();
  const guest = sessionOf(b);
  guest.local.stamina = {
    value: kick.stamina / 2,
    exhausted: false,
    rested: 0,
  };
  updateSession(guest, kickRight(guest), DT);
  expect(guest.outbox).toEqual([]);
  exchange();
  expect(chaserOf(a).health).toBe(entities.chaser.maxHealth);
});

test("a kick makes a noise from its hitbox on every client, the kicker its source", async () => {
  const { a, b, exchange } = await lineUp();
  exchange({ b: kickRight(sessionOf(b)) });
  const noise = {
    at: { x: TARGET.x, y: TARGET.y },
    loudness: kick.loudness,
    source: "b",
  };
  expect(sessionOf(b).noises).toEqual([noise]);
  updateSession(sessionOf(a), idle, DT);
  expect(sessionOf(a).noises).toEqual([noise]);
});

/** Sends a kick from `room`'s client as if it lunged to `at`, whatever its lunge did. */
function forgeKick(room: Room, at: Point & { aim: number }): void {
  sessionOf(room).outbox.push({
    content: "move/kick",
    event: "kicked",
    route: "host",
    to: null,
    payload: { ...at, action: 1 },
  });
}

test("the host turns down a kick that says it lunged further than the host reckons", async () => {
  const { a, b, exchange, seen, step } = await lineUp();
  const facingRight = { ...idle, aim: { x: GUEST.x + 1000, y: GUEST.y } };
  exchange({ b: facingRight });
  forgeKick(b, { x: GUEST.x, y: GUEST.y + 30, aim: 0 });
  exchange({ b: facingRight });
  step(a, idle);
  expect(chaserOf(a).health).toBe(entities.chaser.maxHealth);
  expect(seen.a.list).toEqual([]);
  expect(seen.b.list).toEqual([]);
});

test("a kick whose lunge the host sees stopped by a wall lands where the host reckons", async () => {
  const { a, b, exchange, seen, step } = await pair();
  const wall = sessionOf(a).world.W;
  const start = { x: wall - 25, y: 300 };
  place(a, { x: 450, y: 150 });
  place(b, start);
  const facingWall = { ...idle, aim: { x: wall + 1000, y: start.y } };
  exchange({ b: facingWall });
  exchange({ b: facingWall });
  forgeKick(b, { x: start.x + PLAYER_LENGTH, y: start.y, aim: 0 });
  exchange({ b: facingWall });
  step(a, idle);
  const flash = seen.a.list[0];
  if (flash === undefined) throw new Error("no kick landed");
  const end = flash.at.x - kick.reach;
  expect(end).toBeGreaterThan(start.x);
  expect(end).toBeLessThanOrEqual(wall - testSimConfig.player.radius);
  expect(flash.at.y).toBeCloseTo(start.y);
});

test("a guest that turns and kicks between its ticks lands the kick where it aimed", async () => {
  const { a, b, clock, exchange } = await lineUp();
  exchange();
  b.frame(clock.now());
  const guest = sessionOf(b);
  updateSession(guest, kickRight(guest), DT);
  b.frame(clock.now());
  updateSession(sessionOf(a), idle, DT);
  expect(chaserOf(a).health).toBe(entities.chaser.maxHealth - kick.damage);
});
