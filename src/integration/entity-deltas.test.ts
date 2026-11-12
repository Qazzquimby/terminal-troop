import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { removeEntity, spawnWorldItem } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

/** No chasers, so nothing moves; the cruiser beside the first host. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
  },
};

/** What these tests read of an entity snapshot on the wire. */
const Snapshot = z.object({
  full: z.boolean(),
  entities: z.array(z.object({ id: z.string() })),
  removed: z.array(z.string()),
});

/** An entity snapshot as it went out: whether it was full, the ids it carried, and those gone. */
interface Sent {
  readonly full: boolean;
  readonly ids: string[];
  readonly removed: string[];
}

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Clients on one hub, each recording the entity snapshots it sends. */
function setup() {
  const hub = createHub();
  const clock = createManualClock();
  const sent = new Map<string, Sent[]>();
  const client = (id: string): Room => {
    const port = hub.transport(id, []).port;
    const log: Sent[] = [];
    sent.set(id, log);
    const recording: Transport = {
      ...port,
      send(event, payload) {
        if (event === NetEvent.ENTITIES) {
          const message = Snapshot.parse(payload);
          log.push({
            full: message.full,
            ids: message.entities.map(({ id }) => id),
            removed: message.removed,
          });
        }
        return port.send(event, payload);
      },
    };
    return createRoom({
      localId: id,
      world: "dev",
      transport: recording,
      voice: createNullVoice({ mode: "open", muted: false, volume: 1 }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  };
  const sentBy = (id: string): Sent[] => sent.get(id) ?? [];
  /** Lets `room` send, 200ms on. */
  const tick = (room: Room): void => {
    clock.advance(clock.now() + 200);
    room.frame(clock.now());
  };
  return { client, clock, sentBy, tick };
}

const ids = (room: Room): string[] =>
  [...sessionOf(room).entities.keys()].sort();

test("after a full snapshot the host sends only what changed, and what is gone", async () => {
  const { client, clock, sentBy, tick } = setup();
  const a = client("a");
  const b = client("b");
  await a.join("DELTA", "A");
  await b.join("DELTA", "B");
  clock.advance(1000);
  tick(a);
  const first = sentBy("a").at(-1);
  expect(first?.full).toBe(true);
  expect(first?.ids).toHaveLength(1);
  expect(ids(b)).toEqual(ids(a));

  tick(a);
  expect(sentBy("a").at(-1)).toEqual({ full: false, ids: [], removed: [] });

  const host = sessionOf(a);
  const dropped = spawnWorldItem(host, { x: 300, y: 300 }, "shovel");
  tick(a);
  expect(sentBy("a").at(-1)).toEqual({
    full: false,
    ids: [dropped.id],
    removed: [],
  });
  expect(ids(b)).toEqual(ids(a));

  removeEntity(host, dropped.id);
  tick(a);
  expect(sentBy("a").at(-1)).toEqual({
    full: false,
    ids: [],
    removed: [dropped.id],
  });
  expect(ids(b)).toEqual(ids(a));
});

test("a full snapshot goes out every fullSnapshotMs, and to each newcomer at once", async () => {
  const { client, clock, sentBy, tick } = setup();
  const a = client("a");
  await a.join("DELTA", "A");
  clock.advance(1000);
  tick(a);
  const fulls = () => sentBy("a").filter(({ full }) => full).length;
  expect(fulls()).toBe(1);
  const ticks = testRoomConfig.fullSnapshotMs / 200;
  for (let count = 1; count < ticks; count++) tick(a);
  expect(fulls()).toBe(1);
  tick(a);
  expect(fulls()).toBe(2);

  const c = client("c");
  await c.join("DELTA", "C");
  expect(sentBy("a").at(-1)?.full).toBe(true);
  expect(ids(c)).toEqual(ids(a));
});

test("a snapshot a guest missed is mended by the next full one", async () => {
  const { client, clock, tick } = setup();
  const a = client("a");
  const b = client("b");
  await a.join("DELTA", "A");
  await b.join("DELTA", "B");
  clock.advance(1000);
  tick(a);
  const guest = sessionOf(b);
  const [lying] = [...guest.entities.values()];
  if (lying === undefined) throw new Error("nothing lying");
  guest.entities.delete(lying.id);
  for (let count = 0; count < testRoomConfig.fullSnapshotMs / 200; count++)
    tick(a);
  expect(ids(b)).toEqual(ids(a));
});

test("a new host's first snapshot is full", async () => {
  const { client, clock, sentBy, tick } = setup();
  const a = client("a");
  const b = client("b");
  await a.join("DELTA", "A");
  await b.join("DELTA", "B");
  clock.advance(1000);
  tick(a);
  tick(b);
  expect(sentBy("b")).toEqual([]);
  await a.leave();
  clock.advance(clock.now() + 3000);
  expect(b.hostId()).toBe("b");
  tick(b);
  expect(sentBy("b").at(0)?.full).toBe(true);
  expect(sentBy("b").at(0)?.ids).toHaveLength(1);
});
