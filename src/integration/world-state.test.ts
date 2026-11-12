import { expect, test } from "vitest";
import { z } from "zod";
import { createScope } from "../lib/scope/index.js";
import { NetEvent, createCountingTransport } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession, worldData } from "../sim/index.js";
import type { Controls, Session, WorldContent } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  testRoomConfig,
} from "./room-helpers.js";
import { testSfx, testSimConfig } from "./sim-config.js";

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

const lit = worldData({ schema: z.boolean(), initial: false });
const count = worldData({ schema: z.number().int(), initial: 0 });

/** A content entry with nothing but two parts of world state. */
const beacon: WorldContent = {
  name: "entity/beacon",
  world: { lit, count },
  register: () => undefined,
  populate: () => undefined,
};

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** World state as a host sent it. */
const Sent = z.object({
  host: z.string(),
  term: z.number(),
  entries: z.record(z.string(), z.unknown()),
});
type Sent = z.infer<typeof Sent>;

/** Clients joined to one room on a hub that sends every payload through JSON, the first hosting. */
async function crew(...ids: string[]) {
  const hub = createHub();
  const clock = createManualClock();
  const rooms = new Map<string, Room>();
  /** The world state each client sent, in order. */
  const worlds = new Map<string, Sent[]>();
  /** Each client's broadcasts per second. */
  const rates = new Map<string, (now: number) => number>();
  const join = async (id: string): Promise<Room> => {
    const port = hub.transport(id, []).port;
    const sent: Sent[] = [];
    worlds.set(id, sent);
    const tap: Transport = {
      ...port,
      send(event, payload) {
        for (const message of messages(event, payload))
          if (message.event === NetEvent.WORLD)
            sent.push(Sent.parse(message.payload));
        return port.send(event, payload);
      },
    };
    const counted = createCountingTransport(tap, () => clock.now());
    rates.set(id, (now) => counted.rates(now).sentPerS);
    const room = createRoom({
      localId: id,
      world: "dev",
      transport: counted.transport,
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
      content: [beacon],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await room.join("WORLD", id.toUpperCase());
    rooms.set(id, room);
    return room;
  };
  for (const id of ids) await join(id);
  const get = (id: string): Room => {
    const room = rooms.get(id);
    if (room === undefined) throw new Error(`no client ${id}`);
    return room;
  };
  const game = (id: string): Session => sessionOf(get(id));
  /** Runs every joined client's frames, at 60 a second, for `ms`. */
  const run = (ms: number): void => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      clock.advance(Math.min(end, clock.now() + 1000 / 60));
      for (const room of rooms.values()) {
        if (room.state().kind !== "joined") continue;
        updateSession(sessionOf(room), idle, 1 / 60);
        room.frame(clock.now());
      }
    }
  };
  // Long enough for every client to have heard the host, and the host to have heard so.
  run(2500);
  expect(get(ids[0] ?? "").hostId()).toBe(ids[0]);
  const sentBy = (id: string): Sent[] => worlds.get(id) ?? [];
  const rateOf = (id: string): number => rates.get(id)?.(clock.now()) ?? 0;
  return { hub, clock, get, game, join, run, sentBy, rateOf };
}

/** Runs a frame of `room`, and of no other client, at its next tick. */
function nextTick(
  room: Room,
  clock: ReturnType<typeof createManualClock>,
): void {
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  room.frame(clock.now());
}

test("a change goes out with the next tick, carrying only the entries changed", async () => {
  const { get, game, clock, sentBy } = await crew("a", "b");
  const before = sentBy("a").length;
  count.set(game("a"), 4);
  get("a").frame(clock.now());
  expect(sentBy("a")).toHaveLength(before);

  nextTick(get("a"), clock);
  expect(sentBy("a").slice(before)).toEqual([
    { host: "a", term: 0, entries: { "entity/beacon.count": [1, 4] } },
  ]);
  expect(count.get(game("b"))).toBe(4);
  expect(lit.get(game("b"))).toBe(false);

  nextTick(get("a"), clock);
  expect(sentBy("a")).toHaveLength(before + 1);
});

test("the host sends its world state in full every fullSnapshotMs", async () => {
  const { run, sentBy } = await crew("a", "b");
  const before = sentBy("a").length;
  run(testRoomConfig.fullSnapshotMs + 500);
  const full = sentBy("a").slice(before);
  expect(full).toHaveLength(1);
  expect(full[0]?.entries).toEqual({
    "entity/beacon.lit": [0, false],
    "entity/beacon.count": [0, 0],
    "core/health.players": [0, {}],
    "core/position.forced": [0, {}],
    "core/predictions.handled": [0, {}],
  });
});

test("a late joiner gets the whole world state at once", async () => {
  const { game, join, run } = await crew("a", "b");
  count.set(game("a"), 9);
  lit.set(game("a"), true);
  run(200);
  const c = await join("c");
  expect(count.get(sessionOf(c))).toBe(9);
  expect(lit.get(sessionOf(c))).toBe(true);
});

test("a late or repeated message never rolls an entry back", async () => {
  const { get, game, clock, hub, sentBy } = await crew("a", "b");
  count.set(game("a"), 1);
  nextTick(get("a"), clock);
  const first = sentBy("a").at(-1);
  count.set(game("a"), 2);
  nextTick(get("a"), clock);
  const second = sentBy("a").at(-1);
  expect(count.get(game("b"))).toBe(2);

  const other = hub.listener("dev:WORLD");
  other.send(NetEvent.WORLD, first);
  other.send(NetEvent.WORLD, second);
  expect(count.get(game("b"))).toBe(2);
});

test("world state from a client the room does not take for the host is ignored", async () => {
  const { game, hub } = await crew("a", "b");
  const other = hub.listener("dev:WORLD");
  other.send(NetEvent.WORLD, {
    host: "z",
    term: 0,
    entries: { "entity/beacon.count": [5, 5] },
  });
  other.send(NetEvent.WORLD, {
    host: "a",
    term: 3,
    entries: { "entity/beacon.count": [5, 5] },
  });
  expect(count.get(game("b"))).toBe(0);
});

test("a new host keeps the world state and counts on from its versions, a term later", async () => {
  const { get, game, clock, run, sentBy } = await crew("a", "b", "c");
  count.set(game("a"), 1);
  count.set(game("a"), 2);
  run(200);
  await get("a").leave();
  clock.advance(clock.now() + 3000);
  expect(get("b").hostId()).toBe("b");
  expect(count.get(game("b"))).toBe(2);
  run(1500);

  count.set(game("b"), 3);
  run(200);
  expect(sentBy("b").at(-1)).toEqual({
    host: "b",
    term: 1,
    entries: { "entity/beacon.count": [3, 3] },
  });
  expect(count.get(game("c"))).toBe(3);
});

test("after a split heals, every client holds the world state of the host the room settles on", async () => {
  const { hub, game, get, run } = await crew("a", "b", "c");
  hub.partition(["a"], ["b", "c"]);
  run(6000);
  expect([get("a").hostId(), get("b").hostId()]).toEqual(["a", "b"]);
  // The side cut off changes its state more often, so its versions run higher.
  for (let n = 1; n <= 5; n++) count.set(game("a"), 100 + n);
  lit.set(game("a"), true);
  count.set(game("b"), 7);
  run(500);
  expect(count.get(game("c"))).toBe(7);

  hub.heal();
  run(8000);
  expect(["a", "b", "c"].map((id) => get(id).hostId())).toEqual([
    "b",
    "b",
    "b",
  ]);
  for (const id of ["a", "b", "c"]) {
    expect(count.get(game(id))).toBe(7);
    expect(lit.get(game(id))).toBe(false);
  }
  count.set(game("b"), 8);
  run(200);
  expect(count.get(game("a"))).toBe(8);
});

test("a host whose world state changes every frame still sends one broadcast a tick", async () => {
  const { game, run, rateOf } = await crew("a", "b");
  const frames = 120;
  for (let frame = 0; frame < frames; frame++) {
    count.set(game("a"), frame);
    lit.set(game("a"), frame % 2 === 0);
    run(1000 / 60);
  }
  expect(rateOf("a")).toBeLessThanOrEqual(testRoomConfig.sendHz + 1);
  expect(count.get(game("b"))).toBeGreaterThan(frames - 10);
});
