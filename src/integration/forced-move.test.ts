import { expect, test } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  correctPlayer,
  expectedEpoch,
  hurtPlayer,
  isAreaFree,
  startDash,
  updateSession,
} from "../sim/index.js";
import type { Controls, Player, Point, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const { radius, knockbackSeconds } = testSimConfig.player;
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
const walkUp: Controls = { ...idle, move: { x: 0, y: -1 } };

/** Where each client's player stands at first. */
const SPOTS = {
  a: { x: 150, y: 300 },
  b: { x: 450, y: 450 },
  c: { x: 750, y: 450 },
} as const;
const spots: Readonly<Record<string, Point>> = SPOTS;
/** Free floor apart from every player, where the host puts one. */
const THERE = { x: 300, y: 300 };
/** How far the tests push a player. */
const PUSH = 60;

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** The player `id` as `room` knows it. */
function playerOn(room: Room, id: string): Player {
  const player = sessionOf(room).players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

/** Clients `ids` joined to one room on a JSON hub, the first hosting, each at its spot. */
async function crew(...ids: string[]) {
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
  const rooms = new Map(ids.map((id) => [id, client(id)]));
  const room = (id: string): Room => {
    const found = rooms.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return found;
  };
  for (const [id, each] of rooms) await each.join("FRIEND", id.toUpperCase());
  clock.advance(1000);
  /** One sim step and frame on each client still in the room, `controls` by client id. */
  const step = (controls: Readonly<Record<string, Controls>> = {}): void => {
    for (const [id, each] of rooms) {
      if (each.state().kind !== "joined") continue;
      updateSession(sessionOf(each), controls[id] ?? idle, DT);
      each.frame(clock.now());
    }
    clock.advance(clock.now() + DT * 1000);
  };
  /** Steps for `ms` of time. */
  const run = (
    ms: number,
    controls: Readonly<Record<string, Controls>> = {},
  ): void => {
    for (let at = 0; at < ms; at += DT * 1000) step(controls);
  };
  // Copies easing from where each player first arrived can shove the others aside, so twice.
  for (let round = 0; round < 2; round++) {
    for (const [id, each] of rooms) {
      const at = spots[id];
      if (at !== undefined) standAt(sessionOf(each), at);
    }
    run(1000);
  }
  expect(room(ids[0] ?? "").hostId()).toBe(ids[0]);
  return { hub, clock, rooms, room, client, step, run };
}

/** Where every client in `rooms` sees player `id`: its own client where it is, others where it is headed. */
function seenEverywhere(rooms: ReadonlyMap<string, Room>, id: string) {
  return [...rooms].map(([each, room]) => {
    const player = playerOn(room, id);
    return each === id
      ? { x: player.x, y: player.y }
      : { x: player.tx, y: player.ty };
  });
}

function expectNear(at: Point, to: Point, within = 0.5): void {
  expect(Math.hypot(at.x - to.x, at.y - to.y)).toBeLessThan(within);
}

test("the spots the tests use are free floor, pushes included", async () => {
  const { room } = await crew("a");
  const { map } = sessionOf(room("a")).world;
  for (const at of [...Object.values(SPOTS), THERE])
    expect(isAreaFree(map, at.x, at.y, radius)).toBe(true);
  const pushed = { x: SPOTS.b.x + PUSH, y: SPOTS.b.y };
  expect(isAreaFree(map, pushed.x, pushed.y, radius)).toBe(true);
});

test("the host corrects a guest, which snaps there and tells the room, and both agree", async () => {
  const { room, step, run } = await crew("a", "b");
  const seen = playerOn(room("a"), "b");
  correctPlayer(sessionOf(room("a")), seen, THERE);
  expect(seen).toMatchObject({ x: THERE.x, y: THERE.y, tx: THERE.x });
  expect(seen).toMatchObject({ prevX: THERE.x, prevY: THERE.y });
  step();
  step();
  const guest = sessionOf(room("b")).local;
  expect(guest).toMatchObject({ x: THERE.x, y: THERE.y, vx: 0, vy: 0 });
  expect(guest).toMatchObject({ prevX: THERE.x, prevY: THERE.y, epoch: 1 });
  run(1000);
  expect(guest).toMatchObject({ x: THERE.x, y: THERE.y });
  expect(seen).toMatchObject({ tx: THERE.x, ty: THERE.y, epoch: 1 });
});

test("the host corrects its own player, and the guest sees it there", async () => {
  const { room, run } = await crew("a", "b");
  const host = sessionOf(room("a")).local;
  correctPlayer(sessionOf(room("a")), host, THERE);
  expect(host).toMatchObject({ x: THERE.x, y: THERE.y, prevX: THERE.x });
  expect(host.epoch).toBe(1);
  run(1000);
  expect(host).toMatchObject({ x: THERE.x, y: THERE.y });
  expect(playerOn(room("b"), "a")).toMatchObject({
    tx: THERE.x,
    ty: THERE.y,
    epoch: 1,
  });
  expect(expectedEpoch(sessionOf(room("b")), "a")).toBe(1);
});

test("a correction cancels the dash under way", async () => {
  const { room, step, run } = await crew("a", "b");
  const game = sessionOf(room("b"));
  startDash(game.local, 0, 200, 1, game.world.map, []);
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), THERE);
  step();
  step();
  expect(game.local.dash).toBeNull();
  run(1000);
  expect(game.local).toMatchObject({ x: THERE.x, y: THERE.y });
});

test("a correction from a client that is not the host does nothing", async () => {
  const { room, run } = await crew("a", "b");
  correctPlayer(sessionOf(room("b")), playerOn(room("b"), "a"), THERE);
  expect(sessionOf(room("b")).outbox).toEqual([]);
  run(1000);
  expect(sessionOf(room("a")).local).toMatchObject(SPOTS.a);
  expect(playerOn(room("b"), "a")).toMatchObject({ tx: 150, epoch: 0 });
});

test("a spot that is not a finite point is ignored", async () => {
  const { room, run } = await crew("a", "b");
  const game = sessionOf(room("a"));
  const seen = playerOn(room("a"), "b");
  const guest = sessionOf(room("b")).local;
  const before = {
    host: { ...game.local },
    seen: { ...seen },
    guest: { x: guest.x, y: guest.y },
  };
  for (const at of [
    { x: Number.NaN, y: THERE.y },
    { x: THERE.x, y: Number.POSITIVE_INFINITY },
    { x: Number.NEGATIVE_INFINITY, y: Number.NaN },
  ]) {
    correctPlayer(game, game.local, at);
    correctPlayer(game, seen, at);
  }
  expect(game.outbox).toEqual([]);
  expect(game.local).toEqual(before.host);
  expect(seen).toEqual(before.seen);
  run(1000);
  expect(guest).toMatchObject(before.guest);
});

test("a spot inside a wall is moved to the nearest free floor", async () => {
  const { room, run } = await crew("a", "b");
  const { world } = sessionOf(room("a"));
  const inWall = { x: world.W - 2, y: THERE.y };
  expect(isAreaFree(world.map, inWall.x, inWall.y, radius)).toBe(false);
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), inWall);
  run(1000);
  const guest = sessionOf(room("b")).local;
  expect(isAreaFree(world.map, guest.x, guest.y, radius)).toBe(true);
  expect(Math.hypot(guest.x - inWall.x, guest.y - inWall.y)).toBeLessThan(
    radius * 2,
  );
  expect(playerOn(room("a"), "b").tx).toBeCloseTo(guest.x, 1);
});

test("a knockback slides the victim to the host's end point on every client alike", async () => {
  const { rooms, room, step, run } = await crew("a", "b", "c");
  const start = { x: SPOTS.b.x, y: SPOTS.b.y };
  const end = { x: start.x + PUSH, y: start.y };
  hurtPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), 0, {
    from: { x: start.x - 30, y: start.y },
    distance: PUSH,
  });
  const steps = Math.ceil(knockbackSeconds / DT) + 4;
  const paths = new Map<string, number[]>(
    [...rooms.keys()].map((id) => [id, []]),
  );
  for (let at = 0; at < steps; at++) {
    step();
    for (const [id, each] of rooms) {
      const player = playerOn(each, "b");
      expect(player.y).toBeCloseTo(start.y, 1);
      paths.get(id)?.push(player.x);
    }
  }
  for (const path of paths.values()) {
    const moving = path.filter((x) => x > start.x + 1 && x < end.x - 1);
    expect(moving.length).toBeGreaterThanOrEqual(
      Math.floor(knockbackSeconds / DT) - 2,
    );
    path.slice(1).forEach((x, at) => {
      expect(x).toBeGreaterThan((path[at] ?? 0) - 1e-6);
    });
    expect(path.at(-1)).toBeCloseTo(end.x, 2);
  }
  run(1000);
  for (const at of seenEverywhere(rooms, "b")) expectNear(at, end, 0.1);
  for (const each of rooms.values())
    expect(expectedEpoch(sessionOf(each), "b")).toBe(1);
});

test("a knockback on the host's own player slides it on every client", async () => {
  const { rooms, room, run } = await crew("a", "b");
  const game = sessionOf(room("a"));
  const start = { x: game.local.x, y: game.local.y };
  const end = { x: start.x, y: start.y + PUSH };
  hurtPlayer(game, game.local, 10, {
    from: { x: start.x, y: start.y - 30 },
    distance: PUSH,
  });
  expect(game.local.health).toBe(testSimConfig.player.maxHealth - 10);
  expect(game.local.dash?.to).toEqual(end);
  expect(game.local.epoch).toBe(1);
  run(1000);
  for (const at of seenEverywhere(rooms, "a")) expectNear(at, end, 0.1);
  expect(playerOn(room("b"), "a").epoch).toBe(1);
});

test("a STATE that crosses a forced move is ignored everywhere, and the player's later ones are not", async () => {
  const { hub, rooms, room, step, run } = await crew("a", "b", "c");
  const guest = sessionOf(room("b"));
  hub.hold();
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), THERE);
  step({ b: walkUp });
  guest.reportNow = true;
  step({ b: walkUp });
  hub.release("c");
  hub.release("a");
  step();
  for (const id of ["a", "c"])
    expect(playerOn(room(id), "b")).toMatchObject({
      tx: THERE.x,
      ty: THERE.y,
      epoch: 0,
    });
  hub.flush();
  run(200);
  expect(guest.local).toMatchObject({ x: THERE.x, y: THERE.y, epoch: 1 });
  run(500, { b: walkUp });
  expect(guest.local.y).toBeLessThan(THERE.y - 50);
  run(500);
  for (const at of seenEverywhere(rooms, "b")) expectNear(at, guest.local, 0.1);
});

test("a victim that ignores the push stays at the forced spot on every client until it complies", async () => {
  const { rooms, room, run } = await crew("a", "b", "c");
  const guest = sessionOf(room("b"));
  guest.ignoresForcedMoves = true;
  const start = { x: SPOTS.b.x, y: SPOTS.b.y };
  const end = { x: start.x + PUSH, y: start.y };
  hurtPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), 5, {
    from: { x: start.x - 30, y: start.y },
    distance: PUSH,
  });
  run(1000, { b: walkUp });
  expect(guest.local.epoch).toBe(0);
  expect(guest.local.y).toBeLessThan(start.y - 100);
  expect(guest.local.health).toBe(testSimConfig.player.maxHealth - 5);
  for (const id of ["a", "c"]) {
    const seen = playerOn(room(id), "b");
    expectNear(seen, end, 0.1);
    expectNear({ x: seen.tx, y: seen.ty }, end, 0.1);
    expect(seen.health).toBe(95);
  }
  guest.ignoresForcedMoves = false;
  run(500);
  expectNear(guest.local, end, 0.01);
  expect(guest.local.epoch).toBe(1);
  run(500, { b: walkUp });
  run(500);
  expect(guest.local.y).toBeLessThan(end.y - 50);
  for (const at of seenEverywhere(rooms, "b")) expectNear(at, guest.local, 0.1);
});

test("a forced move whose messages are lost reaches every client with the world state", async () => {
  const { hub, rooms, room, run } = await crew("a", "b", "c");
  hub.hold();
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), THERE);
  run(300);
  hub.drop("b");
  hub.drop("c");
  hub.flush();
  expect(sessionOf(room("b")).local).toMatchObject({ epoch: 0 });
  expect(expectedEpoch(sessionOf(room("c")), "b")).toBe(0);
  run(testRoomConfig.fullSnapshotMs);
  expect(sessionOf(room("b")).local).toMatchObject({
    x: THERE.x,
    y: THERE.y,
    epoch: 1,
  });
  run(500);
  for (const at of seenEverywhere(rooms, "b")) expectNear(at, THERE, 0.1);
  expect(expectedEpoch(sessionOf(room("c")), "b")).toBe(1);
});

test("a new host counts on from the epochs it heard, even one only the player's STATE told it", async () => {
  const { hub, rooms, room, run } = await crew("a", "b", "c");
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "c"), THERE);
  run(500);
  hub.hold();
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "c"), SPOTS.c);
  run(300);
  hub.drop("b");
  hub.flush();
  run(500);
  expect(sessionOf(room("c")).local.epoch).toBe(2);
  expect(expectedEpoch(sessionOf(room("b")), "c")).toBe(1);
  await room("a").leave();
  rooms.delete("a");
  run(3000);
  expect(room("b").hostId()).toBe("b");
  expect(expectedEpoch(sessionOf(room("b")), "c")).toBe(2);
  expectNear(playerOn(room("b"), "c"), SPOTS.c, 0.1);
  correctPlayer(sessionOf(room("b")), playerOn(room("b"), "c"), THERE);
  run(500);
  expect(sessionOf(room("c")).local).toMatchObject({
    x: THERE.x,
    y: THERE.y,
    epoch: 3,
  });
  for (const at of seenEverywhere(rooms, "c")) expectNear(at, THERE, 0.1);
});

test("a player that joins again takes up the room's count where it stands, without being moved", async () => {
  const { rooms, room, client, run } = await crew("a", "b");
  correctPlayer(sessionOf(room("a")), playerOn(room("a"), "b"), THERE);
  run(500);
  await room("b").leave();
  const again = client("b");
  rooms.set("b", again);
  await again.join("FRIEND", "B");
  const fresh = sessionOf(again);
  standAt(fresh, SPOTS.c);
  expect(fresh.local.epoch).toBe(0);
  run(500);
  expect(fresh.local).toMatchObject({ ...SPOTS.c, epoch: 1 });
  expect(playerOn(room("a"), "b")).toMatchObject({ ...{ tx: 750, ty: 450 } });
  run(500, { b: walkUp });
  run(500);
  for (const at of seenEverywhere(rooms, "b")) expectNear(at, fresh.local, 0.1);
});

test("a blow without a push, as a zombie strikes, moves no one", async () => {
  const { room, run } = await crew("a", "b");
  const game = sessionOf(room("a"));
  hurtPlayer(game, playerOn(room("a"), "b"), 7);
  expect(game.outbox).toEqual([
    expect.objectContaining({ content: "core/health", payload: { amount: 7 } }),
  ]);
  run(500);
  expect(sessionOf(room("b")).local).toMatchObject({
    ...SPOTS.b,
    health: testSimConfig.player.maxHealth - 7,
    epoch: 0,
  });
  expect(expectedEpoch(game, "b")).toBe(0);
});
