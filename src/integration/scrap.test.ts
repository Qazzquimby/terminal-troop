import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { credit, itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  giveItem,
  heldItemOf,
  isAreaFree,
  itemIn,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { teleport } from "./crew.js";
import {
  createHub,
  createManualClock,
  tenth,
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
  drop: false,
};

/** No zombies, so nothing moves; the cruiser beside the first host. */
const entities = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Every client of the crew under test still in the room. */
let crewRooms: Room[] = [];

/**
 * Puts `room`'s player at `at`, as the host would: the host runs it on from there, and its own
 * client takes that from the host's next snapshot.
 */
function place(room: Room, at: Point): void {
  const games = crewRooms
    .filter((each) => each.state().kind === "joined")
    .map(sessionOf);
  teleport(games, sessionOf(room).localId, at);
}

const scrapCarried = (room: Room): number =>
  sessionOf(room).local.inventory.filter((item) => item?.id === "scrap").length;

/** As the host, gives `room`'s player `count` scrap, from its second slot on; it holds the first. */
function stock(host: Room, room: Room, count: number): void {
  const game = sessionOf(room);
  for (let slot = 1; slot <= count; slot++)
    expect(giveItem(sessionOf(host), game.localId, "scrap", slot)).toBe(true);
  game.local.held = 1;
}

/** How much scrap the host's record has `room`'s player carrying. */
const scrapRecorded = (host: Room, room: Room): number =>
  [0, 1, 2, 3, 4, 5].filter(
    (slot) =>
      itemIn(sessionOf(host), sessionOf(room).localId, slot) === "scrap",
  ).length;

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
    crewRooms = [...rooms.values()];
    return room;
  };
  for (const id of ids) await join(id);
  crewRooms = [...rooms.values()];
  clock.advance(1000);
  const get = (id: string): Room => {
    const room = rooms.get(id);
    if (room === undefined) throw new Error(`no client ${id}`);
    return room;
  };
  /**
   * Every client still in the room steps and sends for `seconds`, 0.2s by default: long enough
   * for what a guest sends to reach the host, and the host's answer to come back.
   */
  const exchange = (seconds = 0.2): void => {
    const joined = [...rooms.values()].filter(
      (room) => room.state().kind === "joined",
    );
    for (let at = 0; at < seconds; at += DT) {
      for (const room of joined) {
        updateSession(sessionOf(room), idle, DT);
        room.frame(clock.now());
      }
      clock.advance(clock.now() + DT * 1000);
    }
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

test("a guest holding scrap by the cruiser sells it on the host: the team's credit rises on every client, and the scrap is gone", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(get("a"), b, 1);
  place(b, byCruiser(b, 60));
  exchange(1);
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  expect(credit.get(sessionOf(b))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(0);
  expect(scrapRecorded(get("a"), b)).toBe(0);
  expect(rang(get("a"))).toBe(true);
});

test("sold scrap is gone from the host's record: a client that keeps showing it sells nothing more", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  const guest = sessionOf(b);
  stock(get("a"), b, 1);
  place(b, byCruiser(b, 60));
  exchange(1);
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  const definition = guest.itemDefinitions.get("scrap");
  if (definition === undefined) throw new Error("no scrap");
  for (let round = 0; round < 20; round++) {
    guest.local.inventory[1] = definition;
    exchange();
  }
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  expect(scrapRecorded(get("a"), b)).toBe(0);
});

test("held scrap sells one at a time; scrap not held stays", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(get("a"), b, 3);
  place(b, byCruiser(b, 60));
  exchange(1);
  expect(credit.get(sessionOf(get("a")))).toBe(scrap.value);
  expect(scrapCarried(b)).toBe(2);
  sessionOf(b).local.held = 2;
  exchange(1);
  expect(credit.get(sessionOf(b))).toBe(scrap.value * 2);
  expect(scrapCarried(b)).toBe(1);
});

test("the host sells its own scrap the same way", async () => {
  const { get, exchange } = await crew("a", "b");
  const a = get("a");
  stock(a, a, 1);
  place(a, byCruiser(a, 60));
  exchange(1);
  expect(credit.get(sessionOf(a))).toBe(scrap.value);
  expect(credit.get(sessionOf(get("b")))).toBe(scrap.value);
  expect(scrapCarried(a)).toBe(0);
});

test("scrap held away from the cruiser does not sell", async () => {
  const { get, exchange } = await crew("a", "b");
  const b = get("b");
  stock(get("a"), b, 1);
  place(b, byCruiser(b, scrap.cashoutRadius + 60));
  exchange(1);
  expect(credit.get(sessionOf(get("a")))).toBe(0);
  expect(scrapCarried(b)).toBe(1);
});

test("a late joiner sees the team's credit", async () => {
  const { get, join, exchange } = await crew("a", "b");
  const b = get("b");
  stock(get("a"), b, 1);
  place(b, byCruiser(b, 60));
  exchange();
  exchange();
  const c = await join("c");
  expect(credit.get(sessionOf(c))).toBe(scrap.value);
});

test("the team's credit survives the host leaving, and the new host sells on from it", async () => {
  const { get, exchange, clock } = await crew("a", "b", "c");
  const b = get("b");
  stock(get("a"), b, 2);
  place(b, byCruiser(b, 60));
  exchange();
  exchange();
  expect(credit.get(sessionOf(get("c")))).toBe(scrap.value);

  await get("a").leave();
  clock.advance(clock.now() + 3000);
  expect(b.hostId()).toBe("b");
  expect(credit.get(sessionOf(b))).toBe(scrap.value);
  sessionOf(b).local.held = 2;
  exchange(1);
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
      .map(({ id, x, y, data }) => ({ id, x: tenth(x), y: tenth(y), data }));
  expect(lying(get("a"))).toHaveLength(3);
  expect(lying(get("a"))[0]?.data).toEqual({ item: "scrap" });
  expect(lying(get("b"))).toEqual(lying(get("a")));
});

test("a sale the host makes as it goes is credited once: the next host's record has the scrap gone", async () => {
  const { get, exchange, hub, clock } = await crew("a", "b", "c");
  const a = get("a");
  const c = get("c");
  stock(get("a"), c, 1);
  place(c, byCruiser(c, scrap.cashoutRadius + 60));
  exchange(1);
  place(c, byCruiser(c, 60));
  // The host sells, but only b hears it before the host goes.
  hub.partition(["a", "b"], ["c"]);
  exchange(1);
  hub.heal();
  expect(credit.get(sessionOf(get("b")))).toBe(scrap.value);
  expect(scrapRecorded(get("b"), c)).toBe(0);

  await a.leave();
  clock.advance(clock.now() + 3000);
  expect(get("b").hostId()).toBe("b");
  exchange(1);
  expect(credit.get(sessionOf(get("b")))).toBe(scrap.value);
  expect(credit.get(sessionOf(c))).toBe(scrap.value);
  expect(scrapCarried(c)).toBe(0);
});

/** What `room`'s client sees player `id` hold. */
function seenHolding(room: Room, id: string): string | null {
  const game = sessionOf(room);
  const player = game.players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return heldItemOf(game, player)?.id ?? null;
}

test("a player joining starts with the starting items, in the host's record and its own", async () => {
  const { get, join, exchange } = await crew("a", "b");
  const c = await join("c");
  exchange();
  exchange();
  for (const room of [get("b"), c]) {
    expect(itemIn(sessionOf(get("a")), sessionOf(room).localId, 0)).toBe(
      "shovel",
    );
    expect(sessionOf(room).local.inventory[0]?.id).toBe("shovel");
  }
});

test("a late joiner sees what each player holds, from the host's record", async () => {
  const { get, join, exchange } = await crew("a", "b");
  const b = get("b");
  stock(get("a"), b, 1);
  place(b, byCruiser(b, scrap.cashoutRadius + 60));
  exchange();
  const c = await join("c");
  exchange();
  exchange();
  expect(seenHolding(c, "a")).toBe("shovel");
  expect(seenHolding(c, "b")).toBe("scrap");
  sessionOf(b).local.held = 2;
  exchange();
  exchange();
  expect(seenHolding(c, "b")).toBeNull();
  expect(seenHolding(get("a"), "b")).toBeNull();
});

test("everyone's items survive the host leaving, and the new host keeps them", async () => {
  const { get, exchange, clock } = await crew("a", "b", "c");
  const c = get("c");
  stock(get("a"), c, 2);
  place(c, byCruiser(c, scrap.cashoutRadius + 60));
  exchange();
  exchange();
  await get("a").leave();
  clock.advance(clock.now() + 3000);
  expect(get("b").hostId()).toBe("b");
  exchange();
  exchange();
  expect(scrapRecorded(get("b"), c)).toBe(2);
  expect(scrapCarried(c)).toBe(2);
  expect(seenHolding(get("b"), "c")).toBe("scrap");
});
