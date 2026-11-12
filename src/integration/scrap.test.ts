import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { credit, itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { isAreaFree, updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
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

const { scrap } = testItemsConfig;
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

const scrapCarried = (room: Room): number =>
  sessionOf(room).local.inventory.filter((item) => item?.id === "scrap").length;

/** Gives `room`'s player `count` scrap, from its second slot on, and holds the first. */
function stock(room: Room, count: number): void {
  const game = sessionOf(room);
  const definition = game.itemDefinitions.get("scrap");
  if (definition === undefined) throw new Error("no scrap");
  for (let slot = 1; slot <= count; slot++)
    game.local.inventory[slot] = definition;
  game.local.held = 1;
}

/** Whether `room`'s client played the sale's sound. */
const rang = (room: Room): boolean =>
  vi
    .mocked(sessionOf(room).sfx.play)
    .mock.calls.some(([url]) => url.includes("cashout"));

/** Clients joined to one room on a hub that sends every payload through JSON, the first hosting. */
async function crew(...ids: string[]) {
  const hub = createHub();
  const clock = createManualClock();
  const rooms = new Map<string, Room>();
  const join = async (id: string): Promise<Room> => {
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
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await room.join("SCRAP", id.toUpperCase());
    vi.spyOn(sessionOf(room).sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
    rooms.set(id, room);
    return room;
  };
  for (const id of ids) await join(id);
  clock.advance(1000);
  const get = (id: string): Room => {
    const room = rooms.get(id);
    if (room === undefined) throw new Error(`no client ${id}`);
    return room;
  };
  /**
   * Each client but the host steps and sends; the host steps, then sends 200ms later; each other
   * client steps once more to take in what the host sent.
   */
  const exchange = (): void => {
    const joined = [...rooms.values()].filter(
      (room) => room.state().kind === "joined",
    );
    const host = get(joined[0]?.hostId() ?? "");
    const others = joined.filter((room) => room !== host);
    for (const room of others) {
      updateSession(sessionOf(room), idle, DT);
      room.frame(clock.now());
    }
    updateSession(sessionOf(host), idle, DT);
    clock.advance(clock.now() + 200);
    host.frame(clock.now());
    for (const room of others) updateSession(sessionOf(room), idle, DT);
  };
  const a = get(ids[0] ?? "");
  expect(a.hostId()).toBe(ids[0]);
  exchange();
  return { get, join, exchange, clock, hub };
}

function cruiserOf(room: Room): WorldEntity {
  const kind = sessionOf(room).kindIds.get("cruiser");
  const found = [...sessionOf(room).entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no cruiser");
  return found;
}

/** A spot a player fits, `distance` from the cruiser as `room` knows it. */
function byCruiser(room: Room, distance: number): Point {
  const cruiser = cruiserOf(room);
  const { map } = sessionOf(room).world;
  for (let turn = 0; turn < 64; turn++) {
    const angle = (turn / 64) * Math.PI * 2;
    const x = cruiser.x + Math.cos(angle) * distance;
    const y = cruiser.y + Math.sin(angle) * distance;
    if (isAreaFree(map, x, y, testSimConfig.player.radius)) return { x, y };
  }
  throw new Error("no room by the cruiser");
}

test("a guest holding scrap by the cruiser sells it: the team's credit rises on every client, and the scrap is gone", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(b, 1);
  place(b, byCruiser(b, 60));
  exchange();
  exchange();
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  expect(credit.get(sessionOf(b))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(0);
  expect(rang(get("a"))).toBe(true);
  expect(rang(b)).toBe(true);
});

test("held scrap sells one at a time; scrap not held stays", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(b, 3);
  place(b, byCruiser(b, 60));
  for (let round = 0; round < 6; round++) exchange();
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(2);
  sessionOf(b).local.held = 2;
  for (let round = 0; round < 20; round++) exchange();
  expect(credit.get(sessionOf(b))).toBe(scrap.value * 2);
  expect(scrapCarried(b)).toBe(1);
});

test("the host sells its own scrap the same way", async () => {
  const { get, exchange } = await crew("a", "b");
  const a = get("a");
  stock(a, 1);
  place(a, byCruiser(a, 60));
  for (let round = 0; round < 4; round++) exchange();
  expect(credit.get(sessionOf(a))).toBe(scrap.value);
  expect(credit.get(sessionOf(get("b")))).toBe(scrap.value);
  expect(scrapCarried(a)).toBe(0);
});

test("scrap held away from the cruiser does not sell", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(b, 1);
  place(b, byCruiser(b, scrap.cashoutRadius + 60));
  exchange();
  expect(sessionOf(b).outbox).toEqual([]);
  exchange();
  expect(credit.get(sessionOf(get("a")))).toBe(0);
  expect(scrapCarried(b)).toBe(1);
});

test("the host refuses a sale from a player not holding scrap, or not by the cruiser, and nothing changes hands", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  const guest = sessionOf(b);
  stock(b, 1);
  guest.local.held = 0;
  place(b, byCruiser(b, 60));
  exchange();
  const forge = (at: Point): void => {
    const event = guest.events.get("item/scrap")?.get("sell");
    if (event?.to !== "host") throw new Error("no event");
    event.send(guest, { asked: guest.time, ...at });
    exchange();
    exchange();
  };
  forge(guest.local);
  place(b, byCruiser(b, scrap.cashoutRadius + 60));
  guest.local.held = 1;
  exchange();
  forge(byCruiser(b, 60));
  expect(credit.get(sessionOf(get("a")))).toBe(0);
  expect(scrapCarried(b)).toBe(1);
});

test("a sale whose answer is lost is asked for again, and credited once", async () => {
  const { get, exchange, hub, clock } = await crew("a", "b");
  const a = get("a");
  const b = get("b");
  stock(b, 2);
  place(b, byCruiser(b, scrap.cashoutRadius + 60));
  exchange();
  place(b, byCruiser(b, 60));
  updateSession(sessionOf(b), idle, DT);
  b.frame(clock.now());
  hub.partition(["a"], ["b"]);
  updateSession(sessionOf(a), idle, DT);
  a.frame(clock.now() + 200);
  hub.heal();
  expect(credit.get(sessionOf(a))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(2);
  for (let step = 0; step < scrap.sellTimeout / DT + 1; step++)
    updateSession(sessionOf(b), idle, DT);
  exchange();
  exchange();
  expect(credit.get(sessionOf(a))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(1);
});

test("a late joiner sees the team's credit", async () => {
  const { get, join, exchange } = await crew("a", "b");
  const b = get("b");
  stock(b, 1);
  place(b, byCruiser(b, 60));
  exchange();
  exchange();
  const c = await join("c");
  expect(credit.get(sessionOf(c))).toBe(scrap.value);
});

test("the team's credit survives the host leaving, and the new host sells on from it", async () => {
  const { get, exchange, clock } = await crew("a", "b", "c");
  const b = get("b");
  stock(b, 2);
  place(b, byCruiser(b, 60));
  exchange();
  exchange();
  expect(credit.get(sessionOf(get("c")))).toBe(scrap.value);

  await get("a").leave();
  clock.advance(clock.now() + 3000);
  expect(b.hostId()).toBe("b");
  expect(credit.get(sessionOf(b))).toBe(scrap.value);
  sessionOf(b).local.held = 2;
  for (let round = 0; round < 20; round++) exchange();
  expect(credit.get(sessionOf(b))).toBe(scrap.value * 2);
  expect(credit.get(sessionOf(get("c")))).toBe(scrap.value * 2);
});

test("a new world lays its configured scrap about, the same on every client", async () => {
  const { get } = await crew("a", "b");
  const lying = (room: Room) =>
    [...sessionOf(room).entities.values()]
      .filter(
        (entity) =>
          entity.kind === sessionOf(room).kindIds.get("core/world-item"),
      )
      .map(({ id, x, y, data }) => ({ id, x, y, data }));
  expect(lying(get("a"))).toHaveLength(3);
  expect(lying(get("a"))[0]?.data).toEqual({ item: "scrap" });
  expect(lying(get("b"))).toEqual(lying(get("a")));
});
