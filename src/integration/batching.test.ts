import { sum } from "lodash-es";
import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import {
  NetEvent,
  createBatchingTransport,
  createCountingTransport,
} from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { randomFreePosition, updateSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

type Handlers = Parameters<Transport["join"]>[1];

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

test("a batch carries every kind of message over JSON, in order", async () => {
  const hub = createHub();
  const sender = createBatchingTransport(hub.transport("a", []).port);
  const receiver = createBatchingTransport(hub.transport("b", []).port);
  const heard: { event: NetEvent; payload: unknown }[] = [];
  const handlers: Handlers = {};
  for (const event of Object.values(NetEvent))
    handlers[event] = (payload) => heard.push({ event, payload });
  await sender.transport.join("ROOM", {});
  await receiver.transport.join("ROOM", handlers);

  const sent = Object.values(NetEvent)
    .filter((event) => event !== NetEvent.BATCH)
    .map((event, index) => ({ event, payload: { index, at: 0.5 } }));
  sender.batch(() => {
    for (const { event, payload } of sent)
      void sender.transport.send(event, payload);
  });
  expect(heard).toEqual(sent);
});

/** A room joined as "me", and a bare listener that sends it raw broadcasts. */
async function joinedWithListener() {
  const hub = createHub();
  const room = createRoom({
    localId: "me",
    world: "dev",
    transport: hub.transport("me", []).port,
    voice: createNullVoice({
      mode: "open",
      muted: false,
      volume: 1,
      inputDevice: null,
    }),
    sfx: testSfx(),
    scope: createScope(),
    clock: createManualClock(),
    config: testRoomConfig,
    sim: testSimConfig,
    content: [],
    falloff: { full: 100, silent: 600, pan: 300 },
    onChange: () => undefined,
    onPeerFailed: () => undefined,
  });
  await room.join("ABC", "ME");
  return { room, other: hub.listener("dev:ABC") };
}

test("a room handles each message of a batch, dropping one that does not parse and keeping the rest", async () => {
  const { room, other } = await joinedWithListener();
  const session = sessionOf(room);
  const spot = randomFreePosition(session.world, session.local.radius);
  const state = { id: "x", name: "X", ...spot, aim: 0, health: 100, epoch: 0 };
  other.send(NetEvent.BATCH, {
    messages: [
      [NetEvent.STATE, { ...state, id: "y", name: 5, content: {} }],
      [NetEvent.STATE, { ...state, content: {} }],
      [NetEvent.HEARTBEAT, { id: "x", hidden: true, host: null }],
    ],
  });
  expect(session.players.has("y")).toBe(false);
  expect(session.players.get("x")?.name).toBe("X");
  expect(room.presenceOf("x")?.kind).toBe("away");
});

/** No chasers: the host sends its entities every tick all the same. */
const still = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
  },
};

/** Each player walks its own way, turning slowly. */
const walking = (index: number, time: number): Controls => ({
  move: { x: Math.cos(time + index), y: Math.sin(time + index) },
  aim: { x: 1, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
});

test("each player sends about one broadcast a tick, however many messages it carries", async () => {
  const hub = createHub();
  const clock = createManualClock();
  const players = ["a", "b", "c", "d"];
  /** Each player's broadcasts, and the messages those carry, as sent. */
  const counts = new Map(players.map((id) => [id, { messages: 0 }]));
  const counters = players.map((id) => {
    const port = hub.transport(id, []).port;
    const tally: Transport = {
      ...port,
      send(event, payload) {
        const count = counts.get(id);
        if (count !== undefined)
          count.messages += messages(event, payload).length;
        return port.send(event, payload);
      },
    };
    return createCountingTransport(tally, () => clock.now());
  });
  const rooms = counters.map((counted, index) =>
    createRoom({
      localId: players[index] ?? "",
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
      content: [...entityContent(still), ...itemContent(testItemsConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    }),
  );
  for (const room of rooms) await room.join("RATE", "P");

  const seconds = 3;
  for (let frame = 1; frame <= 60 * seconds; frame++) {
    clock.advance((frame * 1000) / 60);
    rooms.forEach((room, index) => {
      updateSession(sessionOf(room), walking(index, frame / 60), 1 / 60);
      room.frame(clock.now());
    });
    if (frame === 60) for (const count of counts.values()) count.messages = 0;
  }

  const sentPerS = counters.map(
    (counted) => counted.rates(clock.now()).sentPerS,
  );
  for (const sent of sentPerS)
    expect(sent).toBeLessThanOrEqual(testRoomConfig.sendHz + 1);
  // Supabase counts each broadcast once sent and once for each other player who receives it.
  const counted = sum(sentPerS) * players.length;
  expect(counted).toBeLessThanOrEqual(
    players.length ** 2 * (testRoomConfig.sendHz + 1),
  );
  // Unbatched, the host's entities and state would each have been a broadcast of their own.
  const host = rooms[0]?.hostId();
  expect(host).toBe("a");
  const hostMessagesPerS = (counts.get("a")?.messages ?? 0) / (seconds - 1);
  expect(hostMessagesPerS).toBeGreaterThan(1.5 * (sentPerS[0] ?? 0));
});
