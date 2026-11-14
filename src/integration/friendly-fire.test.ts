import { expect, test, vi } from "vitest";
import { z } from "zod";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  createSession,
  isAreaFree,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { teleport } from "./crew.js";
import { reportedAt } from "./heard.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testItemsConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const { kick } = testMovesConfig;
const { shovel } = testItemsConfig;
const DT = 1 / 60;
const FULL = testSimConfig.player.maxHealth;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
/** How far a kick sends a player: its configured body lengths of a player. */
const KICKED = PLAYER_LENGTH * kick.knockback;
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

/** Faces right of where `game`'s local player stands, kicking. */
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

/** Faces right of where `game`'s local player stands, swinging its held shovel. */
const swingRight = (game: Session): Controls => ({
  ...idle,
  use: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Keeps `game`'s sounds from playing. */
function mute(game: Session): void {
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** Two clients with the kick and the shovel, joined to one room on a JSON hub, `a` hosting. */
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
      content: [
        ...itemContent(testItemsConfig),
        ...moveContent(testMovesConfig),
      ],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("FRIEND", "A");
  await b.join("FRIEND", "B");
  mute(sessionOf(a));
  mute(sessionOf(b));
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  /** One step and frame on each client, `controls` by client id, each sending as it ticks. */
  const step = (controls: { a?: Controls; b?: Controls } = {}): void => {
    for (const [room, steer] of [
      [a, controls.a],
      [b, controls.b],
    ] as const) {
      updateSession(sessionOf(room), steer ?? idle, DT);
      clock.advance(clock.now() + 1000 * (DT / 2));
      room.frame(clock.now());
    }
  };
  /**
   * One step on `controls`, then a third of a second more: long enough for the host's run of
   * the guest, which trails the guest's own, to take in what it sent, and for the guest to hear
   * back.
   */
  const exchange = (controls: { a?: Controls; b?: Controls } = {}): void => {
    step(controls);
    for (let more = 0; more < 20; more++) step();
  };
  /** Runs until any push has played out and every client has heard where it ended. */
  const settle = (): void => {
    for (let more = 0; more < 60; more++) step();
  };
  /** Puts the host's player at `host` and the guest's at `guest`, still, as the host would. */
  const place = (host: Point, guest: Point): void => {
    const games = [sessionOf(a), sessionOf(b)];
    teleport(games, "a", host);
    teleport(games, "b", guest);
    settle();
  };
  return { a, b, exchange, place, settle };
}

/** The player `id` as `room` knows it. */
function playerOn(room: Room, id: string) {
  const player = sessionOf(room).players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

/** A spot clear of walls, with room to its right for a kick and a push. */
const LEFT = { x: 150, y: 300 };
/** Where a kick from LEFT, facing right, lands once its lunge is done. */
const KICK_AT = { x: LEFT.x + PLAYER_LENGTH + kick.reach, y: LEFT.y };
/** Inside a shovel's hitbox from LEFT facing right, so the push, away from the swinger, goes right. */
const SWING_AT = { x: LEFT.x + shovel.reach + 5, y: LEFT.y };

test("the spots the tests use are clear of walls, push included", () => {
  const game = createSession(
    "me",
    "ME",
    "FRIEND",
    "dev",
    testSfx(),
    testSimConfig,
  );
  for (const at of [LEFT, KICK_AT, { x: KICK_AT.x + KICKED, y: KICK_AT.y }])
    expect(
      isAreaFree(game.world.map, at.x, at.y, testSimConfig.player.radius),
    ).toBe(true);
});

test("a guest's swing hurts the host's player and pushes it away from the swinger", async () => {
  const { a, b, exchange, place, settle } = await pair();
  place(SWING_AT, LEFT);
  exchange({ b: swingRight(sessionOf(b)) });
  const host = sessionOf(a).local;
  expect(host.health).toBe(FULL - shovel.damage);
  settle();
  expect(host.x).toBeCloseTo(SWING_AT.x + shovel.knockback);
  expect(host.y).toBeCloseTo(SWING_AT.y);
  expect(playerOn(b, "a").health).toBe(FULL - shovel.damage);
  expect(playerOn(b, "a").tx).toBeCloseTo(host.x, 1);
  expect(sessionOf(b).local.use?.hit).toBe(true);
});

test("a guest's kick hurts the host's player and knocks it away from the kicker", async () => {
  const { a, b, exchange, place, settle } = await pair();
  place(KICK_AT, LEFT);
  exchange({ b: kickRight(sessionOf(b)) });
  const host = sessionOf(a).local;
  expect(host.health).toBe(FULL - kick.damage);
  settle();
  expect(host.x).toBeCloseTo(KICK_AT.x + KICKED);
  expect(playerOn(b, "a").health).toBe(FULL - kick.damage);
  expect(playerOn(b, "a").tx).toBeCloseTo(host.x, 1);
});

test("a host's kick hurts a guest, whose own client lands it where the host knocks it, and both clients see it", async () => {
  const { a, b, exchange, place, settle } = await pair();
  place(LEFT, KICK_AT);
  exchange({ a: kickRight(sessionOf(a)) });
  const guest = sessionOf(b).local;
  expect(guest.health).toBe(FULL - kick.damage);
  settle();
  expect(guest.x).toBeCloseTo(KICK_AT.x + KICKED);
  expect(guest.y).toBeCloseTo(KICK_AT.y);
  expect(playerOn(a, "b").health).toBe(FULL - kick.damage);
  expect(playerOn(a, "b").x).toBeCloseTo(guest.x, 1);
  expect(playerOn(a, "b").y).toBeCloseTo(guest.y, 1);
  expect(sessionOf(a).local.health).toBe(FULL);
});

test("a push into a wall stops the player there, still hurt", async () => {
  const { a, b, exchange, place, settle } = await pair();
  const wall = sessionOf(a).world.W;
  const kicker = { x: wall - 100, y: LEFT.y };
  place(kicker, { x: kicker.x + PLAYER_LENGTH + kick.reach, y: kicker.y });
  exchange({ a: kickRight(sessionOf(a)) });
  settle();
  const guest = sessionOf(b).local;
  expect(guest.health).toBe(FULL - kick.damage);
  expect(guest.x).toBeCloseTo(wall - testSimConfig.player.radius);
});

test("nobody's kick or swing hurts themselves", async () => {
  const { a, b, exchange, place, settle } = await pair();
  place(LEFT, { x: 450, y: 450 });
  exchange({ a: kickRight(sessionOf(a)) });
  settle();
  exchange({ a: swingRight(sessionOf(a)), b: kickRight(sessionOf(b)) });
  settle();
  exchange({ b: swingRight(sessionOf(b)) });
  settle();
  expect(sessionOf(a).local.health).toBe(FULL);
  expect(sessionOf(b).local.health).toBe(FULL);
  expect(sessionOf(a).local.use?.hit).toBe(false);
  expect(sessionOf(b).local.use?.hit).toBe(false);
});

test("one swing on the host hurts the world entity and the player it catches alike", () => {
  const game = createSession(
    "me",
    "ME",
    "FRIEND",
    "dev",
    testSfx(),
    testSimConfig,
  );
  mute(game);
  registerContent(game, itemContent(testItemsConfig));
  registerEntityType(game, "dummy", {
    radius: 15,
    maxHealth: 40,
    data: z.object({}),
    update: (_entity, data) => data,
    draw: () => undefined,
  });
  standAt(game, LEFT);
  const dummy = spawnEntity(game, "dummy", SWING_AT.x, SWING_AT.y - 15, {});
  const them = reportedAt(game, "them", {
    x: SWING_AT.x,
    y: SWING_AT.y + 15,
  });
  updateSession(game, swingRight(game), DT);
  expect(dummy.health).toBe(40 - shovel.damage);
  expect(them.health).toBe(FULL - shovel.damage);
  // The host knocks the player itself: a slide on its copy, which every other client follows.
  const aim = Math.atan2(15, shovel.reach + 5);
  const to = them.dash?.to ?? { x: NaN, y: NaN };
  expect(to.x).toBeCloseTo(SWING_AT.x + Math.cos(aim) * shovel.knockback, 5);
  expect(to.y).toBeCloseTo(
    SWING_AT.y + 15 + Math.sin(aim) * shovel.knockback,
    5,
  );
  expect(game.local.health).toBe(FULL);
});
