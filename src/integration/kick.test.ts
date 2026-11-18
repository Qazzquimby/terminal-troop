import { expect, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { moveContent } from "../moves/index.js";
import type { Room } from "../room/index.js";
import {
  createSession,
  isAreaFree,
  massOf,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
  PLAYER_TAG,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { crew, playerOn, sessionOf } from "./crew.js";
import { reportedAt } from "./heard.js";
import {
  testEntitiesConfig,
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
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

/** A kind that stands still with 40 health and a radius of 15. */
const DUMMY = "dummy";
const DUMMY_LENGTH = 30;
/** How far a kick sends a body of a player's mass or less: two of the kicker's body lengths. */
const KNOCK = PLAYER_LENGTH * kick.knockback;

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
    mass: 1,
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

test("a guest's kick lunges the kicker one body length, spends its stamina and goes to the host as its aim", () => {
  const game = session();
  game.hosting = false;
  standAt(game, { x: 300, y: 300 });
  updateSession(game, kickRight(game), DT);
  expect(game.local.stamina.value).toBe(
    testSimConfig.stamina.max - kick.stamina,
  );
  expect(game.outbox.filter(({ content }) => content === "move/kick")).toEqual([
    {
      content: "move/kick",
      event: "kick",
      route: "host",
      to: null,
      payload: { action: 1, step: game.step, input: { aim: 0 } },
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
  const before = target.x;
  updateSession(game, kickRight(game), DT);
  expect(game.flashes).toHaveLength(1);
  expect(game.flashes[0]?.at.x).toBeCloseTo(300 + 2 + kick.reach);
  expect(Math.abs((game.flashes[0]?.at.x ?? 0) - before)).toBeLessThan(5);
  expect(target.health).toBe(40 - kick.damage);
});

test("a guest's lunge never runs into a player in the way", () => {
  const game = session();
  // A guest leaves pushing players to the host, so the one in the way stays put.
  game.hosting = false;
  standAt(game, { x: 300, y: 300 });
  reportedAt(game, "them", { x: 340, y: 300 });
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
  expect(pushed).toBeGreaterThan(KNOCK - 5);
  expect(pushed).toBeLessThanOrEqual(KNOCK);
  expect(hit.y).toBeCloseTo(300);
});

/**
 * How far a kick facing right sends a still body of `radius`, and of `mass` (sized to its radius
 * when left out), standing with its near edge in the kick's hitbox.
 */
function kickedDistance(radius: number, mass?: number): number {
  const game = session();
  registerEntityType(game, "block", {
    radius,
    ...(mass !== undefined && { mass }),
    maxHealth: 40,
    data: z.object({}),
    update: (_entity, data) => data,
    draw: () => undefined,
  });
  standAt(game, { x: 300, y: 300 });
  const hitbox = hitboxRightOf(game.local);
  const at = { x: hitbox.x + radius, y: hitbox.y };
  expect(isAreaFree(game.world.map, at.x + KNOCK, at.y, radius)).toBe(true);
  const hit = spawnEntity(game, "block", at.x, at.y, {});
  kickOnce(game);
  expect(hit.health).toBe(40 - kick.damage);
  return hit.x - at.x;
}

test("a kick sends a big body no farther than a small one of the same mass", () => {
  expect(kickedDistance(8, 1)).toBeCloseTo(KNOCK);
  expect(kickedDistance(15, 1)).toBeCloseTo(KNOCK);
  expect(kickedDistance(40, 1)).toBeCloseTo(KNOCK);
});

test("a kick sends a body heavier than the kicker less far, in proportion", () => {
  expect(kickedDistance(15, 2)).toBeCloseTo(KNOCK / 2);
  expect(kickedDistance(15, 4)).toBeCloseTo(KNOCK / 4);
});

test("a body without a declared mass weighs by its size: twice a player's width, four times as heavy", () => {
  const playerRadius = testSimConfig.player.radius;
  expect(kickedDistance(playerRadius * 2)).toBeCloseTo(KNOCK / 4);
  // Lighter than the kicker, it still goes only as far as one of a player's mass.
  expect(kickedDistance(playerRadius / 2)).toBeCloseTo(KNOCK);
});

test("kicking the cruiser moves it slowly, by its mass, and thuds and flashes as a hit", () => {
  const game = session();
  for (const content of entityContent(entities)) {
    content.register(game);
    content.populate(game);
  }
  const cruiserKind = game.kindIds.get("cruiser");
  const car = [...game.entities.values()].find(
    ({ kind }) => kind === cruiserKind,
  );
  if (car === undefined) throw new Error("no cruiser");
  standAt(game, { x: 300, y: 300 });
  const hitbox = hitboxRightOf(game.local);
  const at = { x: hitbox.x + car.radius, y: hitbox.y };
  Object.assign(car, { ...at, prevX: at.x, prevY: at.y, tx: at.x, ty: at.y });
  const play = vi.mocked(game.sfx.play);
  play.mockClear();
  updateSession(game, kickRight(game), DT);
  expect(game.flashes).toEqual([expect.objectContaining({ hit: true })]);
  expect(play).toHaveBeenCalled();
  deliverOwn(game);
  updateSession(game, idle, DT);
  // Heavier than the kicker, it goes that much less far than a body of a player's mass would.
  const share = testSimConfig.player.mass / massOf(game, car);
  expect(share).toBeGreaterThan(0);
  expect(share).toBeLessThan(1);
  expect(car.x - at.x).toBeCloseTo(KNOCK * share);
  expect(car.y).toBe(at.y);
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

test("enough kicks fell a zombie", () => {
  const game = session();
  for (const content of entityContent(entities)) {
    content.register(game);
    content.populate(game);
  }
  const [zombie] = game.entities.values();
  if (zombie === undefined) throw new Error("no zombie");
  const needed = Math.ceil(testEntitiesConfig.zombie.maxHealth / kick.damage);
  for (let count = 1; count <= needed; count++) {
    standAt(game, { x: 200, y: 300 });
    Object.assign(zombie, hitboxRightOf(game.local));
    game.local.stamina = { value: kick.stamina, exhausted: false, rested: 0 };
    kickOnce(game);
    expect(zombie.health).toBe(
      Math.max(0, testEntitiesConfig.zombie.maxHealth - count * kick.damage),
    );
    wait(game, kick.cooldown);
  }
  expect(game.entities.has(zombie.id)).toBe(false);
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

// Over a room: the host `a` and the guest `b` on a hub that sends every payload through JSON.

function zombieOf(room: Room): WorldEntity {
  const [zombie] = sessionOf(room).entities.values();
  if (zombie === undefined) throw new Error("no zombie");
  return zombie;
}

/** Two clear spots side by side in the dev square, the guest's left of the zombie. */
const HOST = { x: 450, y: 150 };
const GUEST = { x: 150, y: 300 };
const TARGET = hitboxRightOf(GUEST);

/** What each client showed and heard of the blows it saw land, step by step. */
interface Seen {
  readonly flashes: Session["flashes"][number][];
  readonly noises: Session["noises"][number][];
}

/** `a` hosting and `b` its guest, each at its spot, the zombie in the guest's kick's hitbox. */
async function lineUp() {
  const room = await crew(
    {
      spots: { a: HOST, b: GUEST },
      content: [...entityContent(entities), ...moveContent(testMovesConfig)],
    },
    "a",
    "b",
  );
  const seen: Record<string, Seen> = {
    a: { flashes: [], noises: [] },
    b: { flashes: [], noises: [] },
  };
  /** Steps both clients once, `b` with `controls`, noting what each showed and heard. */
  const step = (controls: Controls = idle): void => {
    room.step({ b: controls });
    for (const id of ["a", "b"]) {
      const game = sessionOf(room.room(id));
      seen[id]?.flashes.push(...game.flashes);
      seen[id]?.noises.push(...game.noises);
    }
  };
  const run = (seconds: number, controls: Controls = idle): void => {
    for (let count = 0; count < Math.round(seconds / DT); count++)
      step(controls);
  };
  /** Puts the zombie at `at` on the host, which the guest hears. */
  const putZombie = (at: Point): void => {
    Object.assign(zombieOf(room.room("a")), { ...at, tx: at.x, ty: at.y });
  };
  putZombie(TARGET);
  run(0.5);
  for (const id of ["a", "b"]) {
    seen[id]?.flashes.splice(0);
    seen[id]?.noises.splice(0);
  }
  expect(zombieOf(room.room("b")).tx).toBeCloseTo(TARGET.x, 0);
  expect(
    isAreaFree(sessionOf(room.room("a")).world.map, TARGET.x, TARGET.y, 15),
  ).toBe(true);
  return {
    ...room,
    a: room.room("a"),
    b: room.room("b"),
    seen,
    step,
    run,
    putZombie,
  };
}

test("a guest's kick hurts and knocks back on the host, and both clients see it", async () => {
  const { a, b, seen, step, run } = await lineUp();
  step(kickRight(sessionOf(b)));
  run(0.5);
  const onHost = zombieOf(a);
  expect(onHost.health).toBe(entities.zombie.maxHealth - kick.damage);
  expect(onHost.x - TARGET.x).toBeGreaterThan(KNOCK - 5);
  expect(zombieOf(b)).toMatchObject({ health: onHost.health, tx: onHost.x });
  const flash = { at: TARGET, radius: kick.radius, hit: true };
  expect(seen.a?.flashes).toEqual([expect.objectContaining(flash)]);
  expect(seen.b?.flashes).toEqual([expect.objectContaining(flash)]);
});

test("the host turns down a kick still on cooldown on the guest's own clock, however the guest's client counts", async () => {
  const { a, b, step, run, putZombie } = await lineUp();
  const guest = sessionOf(b);
  step(kickRight(guest));
  run(0.3);
  expect(zombieOf(a).health).toBe(entities.zombie.maxHealth - kick.damage);
  putZombie(hitboxRightOf(playerOn(a, "b")));
  guest.localReadyAt.clear();
  step(kickRight(guest));
  run(0.5);
  expect(zombieOf(a).health).toBe(entities.zombie.maxHealth - kick.damage);
});

test("a guest without the stamina sends no kick", async () => {
  const { a, b, step, run } = await lineUp();
  const guest = sessionOf(b);
  guest.local.stamina = {
    value: kick.stamina / 2,
    exhausted: false,
    rested: 0,
  };
  updateSession(guest, kickRight(guest), DT);
  expect(guest.outbox.filter(({ content }) => content === "move/kick")).toEqual(
    [],
  );
  step();
  run(0.5);
  expect(zombieOf(a).health).toBe(entities.zombie.maxHealth);
});

test("a kick makes one noise from its hitbox on every client, the kicker its source", async () => {
  const { b, seen, step, run } = await lineUp();
  step(kickRight(sessionOf(b)));
  run(0.5);
  const noise = {
    at: { x: TARGET.x, y: TARGET.y },
    radius: kick.noiseRadius,
    source: "b",
    tags: [PLAYER_TAG],
  };
  const kicks = (id: string) =>
    seen[id]?.noises.filter(({ radius }) => radius === kick.noiseRadius);
  expect(kicks("a")).toEqual([noise]);
  expect(kicks("b")).toEqual([noise]);
});

/** Sends a kick facing `aim` from `room`'s client, past its own client's checks. */
function forgeKick(room: Room, aim: number): void {
  const game = sessionOf(room);
  game.outbox.push({
    content: "move/kick",
    event: "kick",
    route: "host",
    to: null,
    payload: { action: ++game.lastAction, step: game.step, input: { aim } },
  });
}

test("the host lunges a kicker from where it runs it, whatever the kicker's client shows", async () => {
  const { a, b, seen, step, run } = await lineUp();
  const guest = sessionOf(b);
  // The guest's own client has it far from the zombie; the host has it by it.
  Object.assign(guest.local, { y: GUEST.y + 200 });
  forgeKick(b, 0);
  step();
  run(0.5);
  expect(zombieOf(a).health).toBe(entities.zombie.maxHealth - kick.damage);
  expect(seen.a?.flashes[0]?.at.x).toBeCloseTo(TARGET.x, 0);
  expect(seen.a?.flashes[0]?.at.y).toBeCloseTo(TARGET.y, 0);
  // And the host puts the guest back where it runs it.
  expect(guest.local.y).toBeCloseTo(GUEST.y, 0);
});

test("a kick whose lunge the host sees stopped by a wall lands where the host reckons", async () => {
  const { a, seen, step, run, place } = await lineUp();
  const wall = sessionOf(a).world.W;
  const start = { x: wall - 25, y: 300 };
  place("b", start);
  const facingWall = { ...idle, aim: { x: wall + 1000, y: start.y } };
  run(1, facingWall);
  seen.a?.flashes.splice(0);
  step({ ...facingWall, secondary: true });
  run(0.5, facingWall);
  const flash = seen.a?.flashes[0];
  if (flash === undefined) throw new Error("no kick landed");
  const end = flash.at.x - kick.reach;
  expect(end).toBeGreaterThan(start.x);
  expect(end).toBeLessThanOrEqual(wall - testSimConfig.player.radius);
  expect(flash.at.y).toBeCloseTo(start.y);
});

test("a guest that turns and kicks in one step lands the kick where it aimed", async () => {
  const { a, b, step, run } = await lineUp();
  const guest = sessionOf(b);
  run(0.3, { ...idle, aim: { x: GUEST.x, y: GUEST.y - 1000 } });
  step(kickRight(guest));
  run(0.5);
  expect(zombieOf(a).health).toBe(entities.zombie.maxHealth - kick.damage);
});
