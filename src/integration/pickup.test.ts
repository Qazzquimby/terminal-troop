import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  defineItem,
  remotePlayers,
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

const BOLT_DROP = "bolt-drop.mp3";

/** A bolt: an item that does nothing, lying about to be picked up, and clinks when dropped. */
const bolt = defineItem("bolt", () => ({
  name: "Bolt",
  emoji: "🔩",
  drop: { url: BOLT_DROP, volume: 1 },
}));

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
      content: [...entityContent(entities), bolt.create({ bolt: undefined })],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await room.join("BOLTS", id.toUpperCase());
    vi.spyOn(sessionOf(room).sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
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
  // Every client stands at its home, and every other client sees it there.
  const goHome = (): void => {
    for (const [index, id] of ids.entries())
      place(get(id), HOMES[index] ?? SPOT);
  };
  goHome();
  exchange();
  goHome();
  for (const id of ids)
    for (const player of remotePlayers(sessionOf(get(id))))
      Object.assign(player, {
        x: player.tx,
        y: player.ty,
        prevX: player.tx,
        prevY: player.ty,
      });
  return { get, host, exchange, clock };
}

const SPOT = { x: 300, y: 300 };

/** Where each client starts, far from SPOT and each other, so no body pushes another off a spot. */
const HOMES: readonly Point[] = [
  { x: 750, y: 500 },
  { x: 700, y: 150 },
  { x: 150, y: 500 },
];

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

test("standing on a bolt with a full inventory, E drops the held item instead", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const lying = layBolt(host, exchange);
  const definition = sessionOf(b).itemDefinitions.get("bolt");
  if (definition === undefined) throw new Error("no bolt");
  sessionOf(b).local.inventory.fill(definition);
  sessionOf(b).local.held = 2;
  place(b, SPOT);
  exchange();
  exchange({ b: reach });
  exchange();
  expect(sessionOf(host).entities.has(lying.id)).toBe(true);
  expect(carried(b)).toEqual(["bolt", "bolt", null, "bolt"]);
  expect(boltsAt(host, SPOT)).toBe(2);
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

/** How many bolts lie within a pixel of `at`, as `room` knows them. */
function boltsAt(room: Room, at: Point): number {
  return [...sessionOf(room).entities.values()].filter(
    (entity) =>
      Math.hypot(entity.x - at.x, entity.y - at.y) < 1 &&
      JSON.stringify(entity.data) === JSON.stringify({ item: "bolt" }),
  ).length;
}

/** Gives `room`'s player a bolt in its second slot, and holds it. */
function holdBolt(room: Room): void {
  const game = sessionOf(room);
  const definition = game.itemDefinitions.get("bolt");
  if (definition === undefined) throw new Error("no bolt");
  game.local.inventory[1] = definition;
  game.local.held = 1;
}

/** Whether `room`'s client played the bolt's drop sound. */
const clinked = (room: Room): boolean =>
  vi
    .mocked(sessionOf(room).sfx.play)
    .mock.calls.some(([url]) => url === BOLT_DROP);

test("with nothing in reach, E drops the held item where the player stands, on every client, with its sound", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  holdBolt(b);
  place(b, SPOT);
  exchange();
  exchange({ b: reach });
  expect(carried(b)).toEqual([null, null, null, null]);
  expect(boltsAt(host, SPOT)).toBe(1);
  expect(boltsAt(b, SPOT)).toBe(1);
  exchange();
  expect(clinked(host)).toBe(true);
  expect(clinked(b)).toBe(true);
});

test("E picks up what is in reach rather than drop the held item", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const lying = layBolt(host, exchange);
  holdBolt(b);
  place(b, SPOT);
  exchange();
  exchange({ b: reach });
  expect(sessionOf(host).entities.has(lying.id)).toBe(false);
  expect(carried(b)).toEqual(["bolt", "bolt", null, null]);
  expect(boltsAt(host, SPOT)).toBe(0);
});

test("with an empty hand and nothing in reach, E does nothing", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  sessionOf(b).local.held = 2;
  place(b, SPOT);
  exchange();
  updateSession(sessionOf(b), reach, DT);
  expect(sessionOf(b).outbox).toEqual([]);
});

test("the host lays nothing for a drop from where the player is not", async () => {
  const { get, host, exchange } = await crew("a", "b");
  const b = get("b");
  const guest = sessionOf(b);
  place(b, SPOT);
  exchange();
  const event = guest.events.get("core/world-items")?.get("dropped");
  if (event?.to !== "host") throw new Error("no event");
  const far = { x: SPOT.x + 200, y: SPOT.y };
  event.send(guest, { item: "bolt", ...far });
  exchange();
  exchange();
  expect(boltsAt(host, far)).toBe(0);
  expect(boltsAt(b, far)).toBe(0);
});

test("a dropped item can be picked up by another player", async () => {
  const { get, exchange } = await crew("a", "b", "c");
  const b = get("b");
  const c = get("c");
  holdBolt(b);
  place(b, SPOT);
  place(c, { x: SPOT.x + 150, y: SPOT.y });
  exchange();
  exchange({ b: reach });
  place(b, { x: SPOT.x - 150, y: SPOT.y });
  place(c, { x: SPOT.x + 10, y: SPOT.y });
  exchange();
  exchange({ c: reach });
  expect(carried(c)).toEqual(["bolt", null, null, null]);
  expect(boltsAt(get("a"), SPOT)).toBe(0);
  expect(boltsAt(b, SPOT)).toBe(0);
});
