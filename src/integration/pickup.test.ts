import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  defineItem,
  removeEntity,
  spawnWorldItem,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
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
const reach: Controls = { ...idle, interact: true };

/** A bolt: an item that does nothing, lying about to be picked up. */
const bolt = defineItem("bolt", () => ({ name: "Bolt", emoji: "🔩" }));

/** No chasers, so nothing moves; the cruiser beside the first host. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
  },
};

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function place(room: Room, at: Point): void {
  Object.assign(sessionOf(room).local, { ...at, prevX: at.x, prevY: at.y });
}

const carried = (room: Room): (string | null)[] =>
  sessionOf(room).local.inventory.map((item) => item?.id ?? null);

/** Clients `ids` joined to one room on a hub that sends every payload through JSON, the first hosting. */
async function crew(...ids: string[]) {
  const hub = createHub();
  const clock = createManualClock();
  const rooms = new Map<string, Room>();
  for (const id of ids) {
    const room = createRoom({
      localId: id,
      world: "dev",
      transport: hub.transport(id, []).port,
      voice: createNullVoice({ mode: "open", muted: false, volume: 1 }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: [...entityContent(entities), bolt.create({ bolt: undefined })],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await room.join("BOLTS", id.toUpperCase());
    rooms.set(id, room);
  }
  clock.advance(1000);
  const get = (id: string): Room => {
    const room = rooms.get(id);
    if (room === undefined) throw new Error(`no client ${id}`);
    return room;
  };
  const host = get(ids[0] ?? "");
  expect(host.hostId()).toBe(ids[0]);
  /**
   * Each guest steps with its controls and sends; the host steps, then sends 200ms later; each
   * guest steps once more to take in what the host sent.
   */
  const exchange = (controls: Readonly<Record<string, Controls>> = {}) => {
    const guests = ids.slice(1).map(get);
    for (const [index, guest] of guests.entries()) {
      updateSession(
        sessionOf(guest),
        controls[ids[index + 1] ?? ""] ?? idle,
        DT,
      );
      guest.frame(clock.now());
    }
    updateSession(sessionOf(host), controls[ids[0] ?? ""] ?? idle, DT);
    clock.advance(clock.now() + 200);
    host.frame(clock.now());
    for (const guest of guests) updateSession(sessionOf(guest), idle, DT);
  };
  return { get, host, exchange, clock };
}

const SPOT = { x: 300, y: 300 };

/** A bolt the host lays at SPOT, once every client has it. */
function layBolt(
  host: Room,
  exchange: () => void,
  at: Point = SPOT,
): WorldEntity {
  const entity = spawnWorldItem(sessionOf(host), at, "bolt");
  exchange();
  return entity;
}

test("a guest picks up a bolt it stands on: the host takes it out of the world and the guest stows it", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const lying = layBolt(host, exchange);
  expect(sessionOf(b).entities.has(lying.id)).toBe(true);
  place(b, { x: SPOT.x + 10, y: SPOT.y });
  exchange();
  exchange({ b: reach });
  expect(sessionOf(host).entities.has(lying.id)).toBe(false);
  expect(sessionOf(b).entities.has(lying.id)).toBe(false);
  expect(carried(b)).toEqual(["bolt", null, null, null]);
  expect(carried(host)).toEqual([null, null, null, null]);
});

test("the host picks up a bolt of its own the same way", async () => {
  const { host, exchange } = await crew("a", "b");
  const lying = layBolt(host, exchange);
  place(host, SPOT);
  exchange({ a: reach });
  exchange();
  exchange();
  expect(sessionOf(host).entities.has(lying.id)).toBe(false);
  expect(carried(host)).toEqual(["bolt", null, null, null]);
});

test("the nearest bolt touching the player is the one picked up", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const far = layBolt(host, exchange, { x: SPOT.x + 18, y: SPOT.y });
  const near = layBolt(host, exchange, { x: SPOT.x - 6, y: SPOT.y });
  place(get("b"), SPOT);
  exchange();
  exchange({ b: reach });
  expect(sessionOf(host).entities.has(near.id)).toBe(false);
  expect(sessionOf(host).entities.has(far.id)).toBe(true);
});

test("two guests reaching for one bolt in the same step: exactly one gets it", async () => {
  const { get, host, exchange } = await crew("a", "b", "c");
  const lying = layBolt(host, exchange);
  place(get("b"), { x: SPOT.x - 12, y: SPOT.y });
  place(get("c"), { x: SPOT.x + 12, y: SPOT.y });
  exchange();
  exchange({ b: reach, c: reach });
  exchange();
  const bolts = ["b", "c"].map(
    (id) => carried(get(id)).filter((item) => item === "bolt").length,
  );
  expect(bolts.sort((x, y) => x - y)).toEqual([0, 1]);
  for (const id of ["a", "b", "c"])
    expect(sessionOf(get(id)).entities.has(lying.id)).toBe(false);
});

test("a guest reaching for nothing it touches picks up nothing", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const lying = layBolt(host, exchange);
  place(get("b"), { x: SPOT.x + 60, y: SPOT.y });
  exchange();
  exchange({ b: reach });
  expect(sessionOf(get("b")).outbox).toEqual([]);
  expect(sessionOf(host).entities.has(lying.id)).toBe(true);
});

test("a guest cannot take what is not a lying item, nor one out of its reach, nor from where it is not", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const guest = sessionOf(b);
  const lying = layBolt(host, exchange);
  place(b, { x: SPOT.x + 150, y: SPOT.y });
  exchange();
  const [cruiser] = [...sessionOf(host).entities.values()].filter(
    (entity) => entity.id !== lying.id,
  );
  if (cruiser === undefined) throw new Error("no cruiser");
  /** Sends the host a pickup as a tampered client could. */
  const forge = (id: string, at: Point): void => {
    const event = guest.events.get("core/world-items")?.get("pickedUp");
    if (event?.to !== "host") throw new Error("no event");
    event.send(guest, { id, ...at });
    exchange();
  };
  forge(cruiser.id, { x: cruiser.x, y: cruiser.y });
  forge(lying.id, guest.local);
  forge(lying.id, SPOT);
  expect(sessionOf(host).entities.has(cruiser.id)).toBe(true);
  expect(sessionOf(host).entities.has(lying.id)).toBe(true);
  expect(carried(b)).toEqual([null, null, null, null]);
  expect(removeEntity(guest, lying.id)).toBe(false);
  expect(guest.entities.has(lying.id)).toBe(true);
});

test("a full inventory reaches for nothing", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const lying = layBolt(host, exchange);
  const definition = sessionOf(b).itemDefinitions.get("bolt");
  if (definition === undefined) throw new Error("no bolt");
  sessionOf(b).local.inventory.fill(definition);
  place(b, SPOT);
  exchange();
  updateSession(sessionOf(b), reach, DT);
  expect(sessionOf(b).outbox).toEqual([]);
  exchange();
  expect(sessionOf(host).entities.has(lying.id)).toBe(true);
});

test("a bolt granted to an inventory that filled meanwhile goes back to the world where the guest stands", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const lying = layBolt(host, exchange);
  place(b, SPOT);
  exchange();
  updateSession(sessionOf(b), reach, DT);
  const definition = sessionOf(b).itemDefinitions.get("bolt");
  if (definition === undefined) throw new Error("no bolt");
  sessionOf(b).local.inventory.fill(definition);
  exchange();
  exchange();
  expect(sessionOf(host).entities.has(lying.id)).toBe(false);
  expect(
    [...sessionOf(host).entities.values()].some(
      (entity) =>
        Math.hypot(entity.x - SPOT.x, entity.y - SPOT.y) < 1 &&
        JSON.stringify(entity.data) === JSON.stringify({ item: "bolt" }),
    ),
  ).toBe(true);
});
