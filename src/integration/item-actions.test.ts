import { expect, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { credit, itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  giveItem,
  isAreaFree,
  itemIn,
  registerEntityType,
  removeEntity,
  spawnEntity,
  spawnWorldItem,
  takeItem,
  updateSession,
} from "../sim/index.js";
import type {
  Controls,
  Point,
  Session,
  WorldContent,
  WorldEntity,
} from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { idle, teleport } from "./crew.js";
import {
  createHub,
  createManualClock,
  delayed,
  forgeAction,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;
const { shovel, scrap } = testItemsConfig;
const FULL = 1000;

/**
 * Where things stand: the host, the guest that acts, the guest that watches, a dummy in the
 * acting guest's swing to the right, the cruiser within selling reach of the acting guest, and
 * a spot both guests touch.
 */
const ACTOR = { x: 150, y: 300 };
const SPOTS: Readonly<Record<string, Point>> = {
  a: { x: 450, y: 150 },
  b: ACTOR,
  c: { x: 150, y: 340 },
};
const TARGET = { x: ACTOR.x + shovel.reach, y: ACTOR.y };
const CRUISER = { x: 250, y: 200 };
const BETWEEN = { x: 150, y: 320 };
/** A spot out of the cruiser's selling reach. */
const AWAY = { x: 750, y: 500 };

/** A still dummy with plenty of health, in the acting guest's swing. */
const dummies: WorldContent = {
  name: "entity/dummy",
  register(game) {
    registerEntityType(game, "dummy", {
      radius: 15,
      maxHealth: FULL,
      data: z.object({}),
      update: (_entity, data) => data,
      draw: () => undefined,
    });
  },
  populate(game) {
    spawnEntity(game, "dummy", TARGET.x, TARGET.y, {});
  },
};

/** None of the scrap lying about to start with. */
const items = {
  ...testItemsConfig,
  scrap: { ...scrap, scatter: { ...scrap.scatter, count: 0 } },
};

/** No zombies: only the cruiser, the dummy and the items. */
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

/** The entities of kind `kind` in `game`. */
const ofKind = (game: Session, kind: string): WorldEntity[] =>
  [...game.entities.values()].filter(
    (entity) => entity.kind === game.kindIds.get(kind),
  );

/** What each client heard of each item sound, by the file's name, and the swing noises made. */
type Heard = Record<string, number>;

/**
 * The host `a`, the guest `b` that acts and the guest `c` that watches, joined to one room on a
 * JSON hub, each send arriving 60 to 180ms later, and placed.
 */
async function room() {
  const hub = createHub();
  const clock = createManualClock();
  let sends = 0;
  const jitter = (): number => 60 + ((sends++ * 37) % 120);
  const clients = new Map<
    string,
    { room: Room; net: ReturnType<typeof delayed>; heard: Heard }
  >();
  for (const id of Object.keys(SPOTS)) {
    const net = delayed(hub.transport(id, []).port, jitter);
    const joined = createRoom({
      localId: id,
      world: "dev",
      transport: net.port,
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
      content: [...entityContent(entities), dummies, ...itemContent(items)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await joined.join("ITEMS", id.toUpperCase());
    net.stamp(clock.now());
    net.flush(Infinity);
    const heard: Heard = {};
    vi.spyOn(sessionOf(joined).sfx, "play").mockImplementation((url) => {
      const file = url.split("/").pop() ?? url;
      // The click of switching slot is the switcher's alone, not an item's sound.
      if (file !== "slot-switch.mp3") heard[file] = (heard[file] ?? 0) + 1;
      return Promise.resolve({
        stop: () => undefined,
        setVolume: () => undefined,
        setPosition: () => undefined,
      });
    });
    clients.set(id, { room: joined, net, heard });
  }
  clock.advance(clock.now() + 1000);
  const client = (id: string) => {
    const found = clients.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return { ...found, game: () => sessionOf(found.room) };
  };

  /** Steps every client once, `controls` by client id, then a step's time. */
  function step(controls: Readonly<Record<string, Controls>> = {}): void {
    for (const [id, { room: joined, net, heard }] of clients) {
      const game = sessionOf(joined);
      updateSession(game, controls[id] ?? idle, DT);
      const swung = game.noises.filter(
        (noise) => noise.radius === shovel.hitNoiseRadius,
      ).length;
      if (swung > 0) heard.noise = (heard.noise ?? 0) + swung;
      const clattered = game.noises.filter(
        (noise) => noise.radius === scrap.dropNoiseRadius,
      ).length;
      if (clattered > 0) heard.clatter = (heard.clatter ?? 0) + clattered;
      joined.frame(clock.now());
      net.stamp(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
    for (const { net } of clients.values()) net.flush(clock.now());
  }
  function run(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step();
  }

  // Players arrive at random before they are placed, and can shove the others aside as they go,
  // so each is put in place twice, as the host would; every client's dummy and cruiser too. Each
  // guest's own client takes its place from the host's snapshots.
  const games = () =>
    [...clients.values()].map(({ room: each }) => sessionOf(each));
  for (let round = 0; round < 2; round++) {
    for (const [id, at] of Object.entries(SPOTS)) teleport(games(), id, at);
    for (const game of games())
      for (const [kind, at] of [
        ["dummy", TARGET],
        ["cruiser", CRUISER],
      ] as const)
        for (const entity of ofKind(game, kind))
          Object.assign(entity, { ...at, tx: at.x, ty: at.y });
    run(1);
  }
  for (const { heard } of clients.values())
    for (const key of Object.keys(heard)) Reflect.deleteProperty(heard, key);
  expect(client("a").room.hostId()).toBe("a");

  /** The dummy, as client `id` knows it. */
  const dummy = (id: string): WorldEntity => {
    const [found] = ofKind(client(id).game(), "dummy");
    if (found === undefined) throw new Error("no dummy");
    return found;
  };
  /** Each slot of client `id`'s items as it shows them. */
  const carried = (id: string): (string | null)[] =>
    client(id)
      .game()
      .local.inventory.map((item) => item?.id ?? null);
  /** Each slot of client `id`'s items as the host keeps them. */
  const recorded = (id: string): (string | null)[] =>
    [0, 1, 2, 3].map((slot) => itemIn(client("a").game(), id, slot));
  /** How many of item `item` lie in the world, as client `id` knows it. */
  const lying = (id: string, item: string): number =>
    ofKind(client(id).game(), "core/world-item").filter(
      (entity) => JSON.stringify(entity.data) === JSON.stringify({ item }),
    ).length;
  /** As the host, gives client `id` scrap in `slot`, and lets the record reach it. */
  const stock = (id: string, slot: number): void => {
    expect(giveItem(client("a").game(), id, "scrap", slot)).toBe(true);
    run(1);
  };
  return { client, step, run, dummy, carried, recorded, lying, stock, games };
}

/** Swinging the held item, facing right of where `game`'s player stands. */
const swingRight = (game: Session): Controls => ({
  ...idle,
  use: true,
  aim: { x: game.local.x + 100, y: game.local.y },
});

const reach: Controls = { ...idle, interact: true };

test("the spots the tests use are clear of walls", async () => {
  const { client } = await room();
  const { map } = client("a").game().world;
  for (const at of [...Object.values(SPOTS), TARGET, BETWEEN])
    expect(isAreaFree(map, at.x, at.y, testSimConfig.player.radius)).toBe(true);
});

test("a guest's swing shows and sounds at once on its own client, and once on every other once the host applies it, with one noise each", async () => {
  const { client, step, run, dummy } = await room();
  step({ b: swingRight(client("b").game()) });
  expect(client("b").game().local.use).toMatchObject({
    item: "shovel",
    hit: true,
  });
  expect(client("b").heard).toEqual({ "hit.mp3": 1 });
  expect(dummy("b").health).toBe(FULL - shovel.damage);
  expect(client("c").game().players.get("b")?.use).toBeNull();
  run(1);
  expect(dummy("a").health).toBe(FULL - shovel.damage);
  expect(dummy("c").health).toBe(FULL - shovel.damage);
  for (const id of ["a", "b", "c"])
    expect([id, client(id).heard]).toEqual([id, { "hit.mp3": 1, noise: 1 }]);
  for (const id of ["a", "c"])
    expect(client(id).game().players.get("b")?.use).toMatchObject({
      item: "shovel",
      center: TARGET,
      hit: true,
    });
});

test("a swing of a slot the host's record has empty shows on no one else, sounds nowhere else, and hurts nothing", async () => {
  const { client, run, dummy } = await room();
  forgeAction(client("b").game(), "item/shovel.use", { slot: 1, aim: 0 });
  run(1);
  expect(dummy("a").health).toBe(FULL);
  for (const id of ["a", "c"]) {
    expect(client(id).game().players.get("b")?.use).toBeNull();
    expect(client(id).heard).toEqual({});
  }
});

test("a swing the host refuses rolls back what the guest's client predicted", async () => {
  const { client, step, run, dummy } = await room();
  const guest = client("b").game();
  // The host's record no longer has the shovel the guest's client still shows.
  expect(takeItem(client("a").game(), "b", 0, "shovel")).toBe(true);
  step({ b: swingRight(guest) });
  expect(guest.local.use).toMatchObject({ item: "shovel", hit: true });
  expect(dummy("b").health).toBe(FULL - shovel.damage);
  run(1);
  expect(dummy("a").health).toBe(FULL);
  expect(dummy("b").health).toBe(FULL);
  expect(client("c").game().players.get("b")?.use).toBeNull();
});

test("two guests reaching for one lying item: both show it at once, one keeps it, the other's rolls back, and it is gone everywhere", async () => {
  const { client, step, run, carried, recorded, lying } = await room();
  const item = spawnWorldItem(client("a").game(), BETWEEN, "scrap");
  run(1);
  expect(lying("b", "scrap")).toBe(1);
  step({ b: reach, c: reach });
  expect(carried("b")).toEqual(["shovel", "scrap", null, null]);
  expect(carried("c")).toEqual(["shovel", "scrap", null, null]);
  run(1);
  const kept = ["b", "c"].map((id) => carried(id)[1]);
  expect(kept.filter((item) => item === "scrap")).toHaveLength(1);
  for (const id of ["b", "c"]) expect(carried(id)).toEqual(recorded(id));
  for (const id of ["a", "b", "c"])
    expect(client(id).game().entities.has(item.id)).toBe(false);
});

test("a guest reaching for an item another player has already taken gets nothing: its pickup rolls back", async () => {
  const { client, step, run, carried, recorded } = await room();
  const item = spawnWorldItem(client("a").game(), BETWEEN, "scrap");
  run(1);
  // Taken on the host, before the guest hears it is gone.
  removeEntity(client("a").game(), item.id);
  step({ b: reach });
  expect(carried("b")).toEqual(["shovel", "scrap", null, null]);
  run(1);
  expect(carried("b")).toEqual(["shovel", null, null, null]);
  expect(recorded("b")).toEqual(["shovel", null, null, null]);
  expect(client("b").game().entities.has(item.id)).toBe(false);
});

test("a guest's drop shows at once and clinks on its own client, then lands once on every client, which each clink once, with one noise each", async () => {
  const { client, step, run, carried, recorded, lying, stock, games } =
    await room();
  // Away from the cruiser, so the scrap stays to be dropped.
  teleport(games(), "b", AWAY);
  run(1);
  stock("b", 2);
  step({ b: { ...idle, drop: true, select: 2 } });
  expect(carried("b")).toEqual(["shovel", null, null, null]);
  expect(client("b").heard).toEqual({ "drop.mp3": 1 });
  expect(lying("b", "scrap")).toBe(0);
  run(1);
  expect(recorded("b")).toEqual(["shovel", null, null, null]);
  for (const id of ["a", "b", "c"]) {
    expect([id, lying(id, "scrap")]).toEqual([id, 1]);
    expect([id, client(id).heard]).toEqual([id, { "drop.mp3": 1, clatter: 1 }]);
  }
});

test("a drop from a slot the host's record has empty lays nothing and sounds nowhere", async () => {
  const { client, run, recorded, lying } = await room();
  for (const slot of [1, 2, 3])
    forgeAction(client("b").game(), "core/world-items.drop", { slot });
  run(1);
  for (const id of ["a", "b", "c"]) {
    expect([id, lying(id, "scrap")]).toEqual([id, 0]);
    expect([id, client(id).heard]).toEqual([id, {}]);
  }
  expect(recorded("b")).toEqual(["shovel", null, null, null]);
});

test("a guest carrying scrap by the cruiser sells it on the host, held or not: the scrap leaves its items and the credit rises on every client", async () => {
  const { client, run, carried, recorded } = await room();
  // `b` holds its shovel; the scrap is in another slot.
  expect(giveItem(client("a").game(), "b", "scrap", 1)).toBe(true);
  run(1);
  expect(recorded("b")).toEqual(["shovel", null, null, null]);
  expect(carried("b")).toEqual(["shovel", null, null, null]);
  for (const id of ["a", "b", "c"])
    expect([id, credit.get(client(id).game())]).toEqual([id, scrap.value]);
  for (const id of ["a", "c"])
    expect([id, client(id).heard]).toEqual([id, { "cashout.mp3": 1 }]);
});

test("the seller's own client rings once for its sale", async () => {
  const { client, step, run, stock } = await room();
  stock("b", 1);
  step({ b: { ...idle, select: 1 } });
  run(1);
  expect(client("b").heard).toEqual({ "cashout.mp3": 1 });
});

test("scrap carried away from the cruiser, held or not, does not sell", async () => {
  const { client, step, run, recorded, stock, games } = await room();
  teleport(games(), "c", AWAY);
  run(1);
  stock("c", 1);
  stock("c", 2);
  step({ c: { ...idle, select: 1 } });
  run(1);
  expect(recorded("c")).toEqual(["shovel", "scrap", "scrap", null]);
  for (const id of ["a", "b", "c"]) {
    expect([id, credit.get(client(id).game())]).toEqual([id, 0]);
    expect([id, client(id).heard]).toEqual([id, {}]);
  }
});

test("every scrap carried by the cruiser sells, in any slot, one each sell interval, the held one first", async () => {
  const { client, step, run, recorded } = await room();
  // `b` holds its last slot, as the host knows, before it has any scrap.
  step({ b: { ...idle, select: 3 } });
  run(1);
  for (const slot of [1, 2, 3])
    expect(giveItem(client("a").game(), "b", "scrap", slot)).toBe(true);
  run(0.1);
  // The held one sold first; the next waits out the interval.
  expect(scrap.sellInterval).toBeGreaterThan(0.1);
  expect(recorded("b")).toEqual(["shovel", "scrap", "scrap", null]);
  expect(credit.get(client("a").game())).toBe(scrap.value);
  run(1);
  expect(recorded("b")).toEqual(["shovel", null, null, null]);
  for (const id of ["a", "b", "c"])
    expect([id, credit.get(client(id).game())]).toEqual([id, scrap.value * 3]);
  expect(client("c").heard).toEqual({ "cashout.mp3": 3 });
});
