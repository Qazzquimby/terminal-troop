import { expect, test } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  correctPlayer,
  isAreaFree,
  startDash,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const { radius } = testSimConfig.player;
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

/** Where the host's player stands. */
const HOST = { x: 150, y: 300 };
/** Where the guest's player stands, apart from the host's. */
const GUEST = { x: 450, y: 450 };
/** Free floor apart from both, where the host puts a player. */
const THERE = { x: 300, y: 300 };

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** Two clients joined to one room on a JSON hub, `a` hosting, standing at HOST and GUEST. */
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
      content: [],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("FRIEND", "A");
  await b.join("FRIEND", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  /** Runs one step on each client and lets every message through, 200ms later. */
  const exchange = (): void => {
    updateSession(sessionOf(b), idle, DT);
    b.frame(clock.now());
    updateSession(sessionOf(a), idle, DT);
    clock.advance(clock.now() + 200);
    a.frame(clock.now());
    updateSession(sessionOf(b), idle, DT);
  };
  const settle = (): void => {
    for (let round = 0; round < 10; round++) exchange();
  };
  standAt(sessionOf(a), HOST);
  standAt(sessionOf(b), GUEST);
  settle();
  return { a, b, exchange, settle };
}

/** The player `id` as `room` knows it. */
function playerOn(room: Room, id: string) {
  const player = sessionOf(room).players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

test("the spots the tests use are free floor", async () => {
  const { a } = await pair();
  const { map } = sessionOf(a).world;
  for (const at of [HOST, GUEST, THERE])
    expect(isAreaFree(map, at.x, at.y, radius)).toBe(true);
});

test("the host corrects a guest, which snaps there and tells the room, and both agree", async () => {
  const { a, b, exchange, settle } = await pair();
  const seen = playerOn(a, "b");
  correctPlayer(sessionOf(a), seen, THERE);
  expect(seen).toMatchObject({ x: THERE.x, y: THERE.y, tx: THERE.x });
  expect(seen).toMatchObject({ prevX: THERE.x, prevY: THERE.y });
  exchange();
  const guest = sessionOf(b).local;
  expect(guest).toMatchObject({ x: THERE.x, y: THERE.y, vx: 0, vy: 0 });
  expect(guest).toMatchObject({ prevX: THERE.x, prevY: THERE.y });
  exchange();
  expect(seen.tx).toBeCloseTo(THERE.x, 1);
  expect(seen.ty).toBeCloseTo(THERE.y, 1);
  settle();
  expect(guest).toMatchObject({ x: THERE.x, y: THERE.y });
  expect(seen.tx).toBeCloseTo(THERE.x, 1);
  expect(seen.ty).toBeCloseTo(THERE.y, 1);
});

test("the host corrects its own player, and the guest sees it there", async () => {
  const { a, b, settle } = await pair();
  const host = sessionOf(a).local;
  correctPlayer(sessionOf(a), host, THERE);
  expect(host).toMatchObject({ x: THERE.x, y: THERE.y, prevX: THERE.x });
  settle();
  expect(host).toMatchObject({ x: THERE.x, y: THERE.y });
  expect(playerOn(b, "a").tx).toBeCloseTo(THERE.x, 1);
  expect(playerOn(b, "a").ty).toBeCloseTo(THERE.y, 1);
});

test("a correction cancels the dash under way", async () => {
  const { a, b, exchange, settle } = await pair();
  const guest = sessionOf(b).local;
  const game = sessionOf(b);
  startDash(guest, 0, 200, 1, game.world.map, []);
  correctPlayer(sessionOf(a), playerOn(a, "b"), THERE);
  exchange();
  expect(guest.dash).toBeNull();
  settle();
  expect(guest).toMatchObject({ x: THERE.x, y: THERE.y });
});

test("a correction from a client that is not the host is ignored", async () => {
  const { a, b, settle } = await pair();
  correctPlayer(sessionOf(b), playerOn(b, "a"), THERE);
  settle();
  expect(sessionOf(a).local).toMatchObject({ x: HOST.x, y: HOST.y });
  expect(playerOn(b, "a").tx).toBeCloseTo(HOST.x, 1);
});

test("a spot inside a wall is moved to the nearest free floor", async () => {
  const { a, b, settle } = await pair();
  const { world } = sessionOf(a);
  const inWall = { x: world.W - 2, y: THERE.y };
  expect(isAreaFree(world.map, inWall.x, inWall.y, radius)).toBe(false);
  correctPlayer(sessionOf(a), playerOn(a, "b"), inWall);
  settle();
  const guest = sessionOf(b).local;
  expect(isAreaFree(world.map, guest.x, guest.y, radius)).toBe(true);
  expect(Math.hypot(guest.x - inWall.x, guest.y - inWall.y)).toBeLessThan(
    radius * 2,
  );
  expect(playerOn(a, "b").tx).toBeCloseTo(guest.x, 1);
});
