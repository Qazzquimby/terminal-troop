import { afterEach, expect, test } from "vitest";
import { createBroadcastChannelTransport } from "../adapters/broadcast-channel-transport/index.js";
import { createScope } from "../lib/scope/index.js";
import { itemContent } from "../items/index.js";
import { entityContent } from "../entities/index.js";
import { NetEvent } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { randomFreePosition, updateSession } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { createManualClock, testRoomConfig } from "./room-helpers.js";
import {
  testEntitiesConfig,
  testSfx,
  testItemsConfig,
  testSimConfig,
} from "./sim-config.js";

const ROOM = "SYNC1";
const SEND_GAP = 1000 / 15;
const open: Room[] = [];
let clock = createManualClock();

afterEach(async () => {
  await Promise.all(open.splice(0).map((room) => room.leave()));
  clock = createManualClock();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A room over BroadcastChannel, with no voice. */
function client(id: string): Room {
  const room = createRoom({
    localId: id,
    world: "standard",
    transport: createBroadcastChannelTransport(NetEvent),
    voice: createNullVoice({ mode: "open", muted: false, volume: 1 }),
    sfx: testSfx(),
    scope: createScope(),
    clock,
    config: testRoomConfig,
    sim: testSimConfig,
    content: [
      ...entityContent(testEntitiesConfig),
      ...itemContent(testItemsConfig),
    ],
    falloff: { full: 100, silent: 600, pan: 300 },
    onChange: () => undefined,
    onPeerFailed: () => undefined,
  });
  open.push(room);
  return room;
}

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Two rooms joined to the same code, each having heard the other's HELLO round. */
async function pair(): Promise<{ a: Room; b: Room }> {
  const a = client("a");
  const b = client("b");
  await a.join(ROOM, "A");
  await b.join(ROOM, "B");
  await flush();
  return { a, b };
}

const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
};

test("clients in the same room build the same world", async () => {
  const { a, b } = await pair();
  expect(sessionOf(a).world.map.solid).toEqual(sessionOf(b).world.map.solid);
});

test("a joining client learns about existing players through HELLO", async () => {
  const { a, b } = await pair();
  const seen = sessionOf(b).players.get("a");
  expect(seen?.name).toBe("A");
  expect(seen?.x).toBe(sessionOf(a).local.x);
  expect(seen?.y).toBe(sessionOf(a).local.y);
  expect(sessionOf(a).players.get("b")?.name).toBe("B");
});

test("remote players are smoothed toward their latest reported position", async () => {
  const { a, b } = await pair();
  const local = sessionOf(a).local;
  // Reports inside a wall are rejected, so move to another known-free spot.
  const target = randomFreePosition(sessionOf(a).world, local.radius);
  local.x = target.x;
  local.y = target.y;
  a.frame(SEND_GAP + 1);
  await flush();

  const remote = sessionOf(b).players.get("a");
  if (remote === undefined) throw new Error("b never saw a");
  expect({ x: remote.tx, y: remote.ty }).toEqual(target);
  const gapBefore = Math.hypot(target.x - remote.x, target.y - remote.y);

  updateSession(sessionOf(b), idle, 1 / 60);
  const gapAfter = Math.hypot(target.x - remote.x, target.y - remote.y);
  expect(gapAfter).toBeLessThan(gapBefore);
  expect(gapAfter).toBeGreaterThan(0);
});

test("state sends are throttled to the send rate", async () => {
  const { a, b } = await pair();
  const local = sessionOf(a).local;
  const sentX = local.x;
  local.x += 5;
  a.frame(1);
  await flush();

  expect(sessionOf(b).players.get("a")?.tx).toBe(sentX);
});

test("leaving says BYE and the other side drops the player", async () => {
  const { a, b } = await pair();
  await b.leave();
  await flush();
  expect(sessionOf(a).players.has("b")).toBe(false);
});

test("a hidden player that stops sending state but keeps heartbeating stays, away", async () => {
  const { a, b } = await pair();
  b.setHidden(true);
  for (let second = 1; second <= 60; second++) {
    clock.advance(second * 1000);
    a.frame(clock.now());
    await flush();
  }
  expect(a.presenceOf("b")).toMatchObject({ kind: "away", hidden: true });
  expect(sessionOf(a).players.has("b")).toBe(true);

  b.setHidden(false);
  await flush();
  expect(a.presenceOf("b")?.kind).toBe("present");
});

const snapshotOf = (room: Room) =>
  [...sessionOf(room).entities.values()].map(({ id, kind, tx, ty, data }) => ({
    id,
    kind,
    x: tx,
    y: ty,
    data,
  }));

/** A pair, the host elected and the first snapshot sent. */
async function hosted(): Promise<{ a: Room; b: Room }> {
  const rooms = await pair();
  clock.advance(1000);
  await flush();
  rooms.a.frame(clock.now());
  await flush();
  return rooms;
}

test("the host's entities reach the other client, ids, kinds, spots and state alike", async () => {
  const { a, b } = await hosted();
  expect(a.hostId()).toBe("a");
  // Three chasers, then the cruiser, numbered by the content list on both clients.
  expect(snapshotOf(a).map(({ kind }) => kind)).toEqual([1, 1, 1, 2]);
  expect(snapshotOf(b)).toEqual(snapshotOf(a));

  for (let step = 0; step < 60; step++)
    updateSession(sessionOf(a), idle, 1 / 60);
  a.frame(clock.now() + 1000);
  await flush();
  expect(snapshotOf(b)).toEqual(snapshotOf(a));
});

test("when the host leaves, the other client runs the same entities on", async () => {
  const { a, b } = await hosted();
  const handed = snapshotOf(b);
  await a.leave();
  await flush();
  clock.advance(2000);
  expect(b.hostId()).toBe("b");
  expect(sessionOf(b).entities.size).toBe(4);
  expect([...sessionOf(b).entities.keys()]).toEqual(handed.map(({ id }) => id));

  for (let step = 0; step < 120; step++)
    updateSession(sessionOf(b), idle, 1 / 60);
  expect(snapshotOf(b)).not.toEqual(handed);
});
