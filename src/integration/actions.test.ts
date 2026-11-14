import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  defineAction,
  effect,
  hurt,
  push,
  registerEntityType,
  sound,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type {
  Point,
  Session,
  WorldContent,
  WorldEntity,
} from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  delayed,
  testRoomConfig,
} from "./room-helpers.js";
import { idle, teleport } from "./crew.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

/** A poke: hurts and shoves one dummy within reach of where the poker stands. */
const POKE = {
  damage: 10,
  shove: 30,
  cooldown: 1,
  stamina: 20,
  reach: 120,
  noise: 300,
  flash: 12,
};
const BOOP = sound({ url: "boop.mp3" });
const FULL = 100;

const Poke = z.object({ target: z.string() });

const poke = defineAction("poke", {
  input: Poke,
  cooldown: POKE.cooldown,
  stamina: POKE.stamina,
  check(game, poker, { target }) {
    const dummy = game.entities.get(target);
    return (
      dummy !== undefined &&
      Math.hypot(dummy.x - poker.x, dummy.y - poker.y) <= POKE.reach
    );
  },
  apply(game, poker, { target }) {
    const dummy = game.entities.get(target);
    if (dummy === undefined) return;
    hurt(game, dummy, POKE.damage);
    push(game, dummy, poker, POKE.shove);
    effect(game, {
      at: { x: dummy.x, y: dummy.y },
      sound: BOOP,
      flash: { radius: POKE.flash, hit: true },
      noise: POKE.noise,
    });
  },
});

/** Where the dummies start: one within the guest's reach, one far beyond it. */
const NEAR = { x: 260, y: 300 };
const FAR = { x: 600, y: 300 };

/** The poke, and two still dummies. */
const pokes: WorldContent = {
  name: "move/poke",
  actions: [poke],
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
    spawnEntity(game, "dummy", NEAR.x, NEAR.y, {});
    spawnEntity(game, "dummy", FAR.x, FAR.y, {});
  },
};

const SPOTS: Readonly<Record<string, Point>> = {
  a: { x: 450, y: 150 },
  b: { x: 150, y: 300 },
  c: { x: 150, y: 480 },
};

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** What each client saw of pokes: flashes shown, boops played, and the poke noises made. */
interface Seen {
  flashes: number;
  boops: number;
  noises: number;
}

/**
 * The host `a`, the guest `b` that pokes and the guest `c` that watches, joined to one room on a
 * JSON hub, each send arriving 60 to 180ms later, each at its spot.
 */
async function room() {
  const hub = createHub();
  const clock = createManualClock();
  let sends = 0;
  const jitter = (): number => 60 + ((sends++ * 37) % 120);
  const clients = new Map<
    string,
    { room: Room; net: ReturnType<typeof delayed>; seen: Seen }
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
      content: [pokes],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await joined.join("POKE", id.toUpperCase());
    net.stamp(clock.now());
    net.flush(Infinity);
    clients.set(id, {
      room: joined,
      net,
      seen: { flashes: 0, boops: 0, noises: 0 },
    });
  }
  clock.advance(clock.now() + 1000);
  const client = (id: string) => {
    const found = clients.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return { ...found, game: () => sessionOf(found.room) };
  };
  for (const [id, { seen }] of clients) {
    const game = client(id).game();
    vi.spyOn(game.sfx, "play").mockImplementation((url) => {
      if (url === BOOP.url) seen.boops++;
      return Promise.resolve({
        stop: () => undefined,
        setVolume: () => undefined,
        setPosition: () => undefined,
      });
    });
  }

  /** Steps every client once, then a step's time. */
  function step(): void {
    for (const { room: joined, net, seen } of clients.values()) {
      const game = sessionOf(joined);
      updateSession(game, idle, DT);
      seen.flashes += game.flashes.length;
      seen.noises += game.noises.filter(
        (noise) => noise.radius === POKE.noise,
      ).length;
      joined.frame(clock.now());
      net.stamp(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
    for (const { net } of clients.values()) net.flush(clock.now());
  }
  function run(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step();
  }
  // Players arrive at random before they are placed, and may shove the dummies.
  const [near, far] = [...client("a").game().entities.keys()];
  const games = () => [...clients.keys()].map((id) => client(id).game());
  for (let round = 0; round < 2; round++) {
    for (const [id, at] of Object.entries(SPOTS)) teleport(games(), id, at);
    for (const [id, at] of [
      [near, NEAR],
      [far, FAR],
    ] as const)
      for (const { room: each } of clients.values()) {
        const found = sessionOf(each).entities.get(id ?? "");
        Object.assign(found ?? {}, { ...at, tx: at.x, ty: at.y });
      }
    run(1);
  }
  expect(client("a").room.hostId()).toBe("a");

  /** The dummy that starts at `at`, as client `id` knows it. */
  const dummy = (id: string, at: Point): WorldEntity => {
    const found = [...client(id).game().entities.values()].find(
      (entity) => Math.hypot(entity.x - at.x, entity.y - at.y) < POKE.shove * 3,
    );
    if (found === undefined) throw new Error(`no dummy near ${String(at.x)}`);
    return found;
  };
  /** Client `id` pokes `target` between steps, and counts the flashes it shows as it does. */
  const pokeFrom = (id: string, target: WorldEntity): boolean => {
    const { game, seen } = client(id);
    const session = game();
    const flashes = session.flashes.length;
    const poked = poke.perform(session, { target: target.id });
    seen.flashes += session.flashes.length - flashes;
    return poked;
  };
  /** Puts player `id` at `at` where the host runs it, and on every other client. */
  const place = (id: string, at: Point): void => {
    teleport(games(), id, at);
  };
  return { client, dummy, pokeFrom, place, run, step };
}

test("a guest's poke shows at once, held until the host confirms it, then settles on the host's state", async () => {
  const { client, dummy, pokeFrom, run } = await room();
  const guest = client("b").game();
  const target = dummy("b", NEAR);
  const before = { x: target.x, y: target.y };
  expect(pokeFrom("b", target)).toBe(true);
  expect(target.health).toBe(FULL - POKE.damage);
  expect(Math.hypot(target.x - before.x, target.y - before.y)).toBeCloseTo(
    POKE.shove,
  );
  expect(guest.predictions.has(target.id)).toBe(true);
  run(testSimConfig.net.predictionHold - 0.05);
  expect(guest.predictions.size).toBe(0);
  run(1);
  const onHost = dummy("a", NEAR);
  expect(onHost.health).toBe(FULL - POKE.damage);
  expect(target.health).toBe(onHost.health);
  expect(target.x).toBeCloseTo(onHost.x, 0);
});

test("a poke the host refuses rolls back to the host's state", async () => {
  const { client, dummy, pokeFrom, run } = await room();
  const guest = client("b").game();
  const target = dummy("b", FAR);
  expect(pokeFrom("b", target)).toBe(true);
  expect(target.health).toBe(FULL - POKE.damage);
  run(testSimConfig.net.predictionHold - 0.05);
  expect(guest.predictions.size).toBe(0);
  run(1);
  expect(dummy("a", FAR).health).toBe(FULL);
  expect(target.health).toBe(FULL);
  expect(target.x).toBeCloseTo(FAR.x, 0);
});

test("a poke plays once on the poker's client and once on every other, and the host makes its noise once", async () => {
  const { client, dummy, pokeFrom, run } = await room();
  pokeFrom("b", dummy("b", NEAR));
  run(1);
  for (const id of ["a", "b", "c"])
    expect([id, client(id).seen]).toEqual([
      id,
      { flashes: 1, boops: 1, noises: 1 },
    ]);
  expect(client("a").net.counts.shown).toBe(1);
  expect(dummy("a", NEAR).health).toBe(FULL - POKE.damage);
});

test("the host's own poke applies at once, and plays once on every client", async () => {
  const { client, dummy, place, pokeFrom, run } = await room();
  place("a", { x: NEAR.x - 100, y: NEAR.y + 50 });
  run(0.5);
  const target = dummy("a", NEAR);
  pokeFrom("a", target);
  expect(target.health).toBe(FULL - POKE.damage);
  run(1);
  expect(target.health).toBe(FULL - POKE.damage);
  expect(dummy("b", NEAR).health).toBe(FULL - POKE.damage);
  for (const id of ["a", "b", "c"])
    expect([id, client(id).seen]).toEqual([
      id,
      { flashes: 1, boops: 1, noises: 1 },
    ]);
});

test("the host holds a guest to the poke's cooldown on the guest's own clock, however its client counts", async () => {
  const { client, dummy, pokeFrom, run } = await room();
  const guest = client("b").game();
  pokeFrom("b", dummy("b", NEAR));
  expect(pokeFrom("b", dummy("b", NEAR))).toBe(false);
  guest.localReadyAt.clear();
  expect(pokeFrom("b", dummy("b", NEAR))).toBe(true);
  run(1);
  expect(dummy("a", NEAR).health).toBe(FULL - POKE.damage);
  expect(dummy("b", NEAR).health).toBe(FULL - POKE.damage);
  expect(client("a").net.counts.shown).toBe(1);
});

test("a guest without the stamina does not poke, and the host refuses one its own run of the guest cannot afford", async () => {
  const { client, dummy, pokeFrom, run } = await room();
  const guest = client("b").game();
  guest.local.stamina = {
    value: POKE.stamina - 1,
    exhausted: false,
    rested: 0,
  };
  expect(pokeFrom("b", dummy("b", NEAR))).toBe(false);
  expect(guest.local.stamina.value).toBe(POKE.stamina - 1);
  guest.local.stamina = { value: FULL, exhausted: false, rested: 0 };
  const onHost = client("a").game().players.get("b");
  if (onHost === undefined) throw new Error("the host has no b");
  onHost.stamina = { value: 0, exhausted: true, rested: 0 };
  expect(pokeFrom("b", dummy("b", NEAR))).toBe(true);
  run(1);
  expect(dummy("a", NEAR).health).toBe(FULL);
  expect(client("a").net.counts.shown).toBe(0);
  // The guest takes the host's word on its stamina.
  expect(guest.local.stamina.value).toBeLessThan(FULL - POKE.stamina);
});

test("the host judges a poke from where it runs the poker, whatever the poker's client shows", async () => {
  const { client, dummy, place, pokeFrom, run } = await room();
  const guest = client("b").game();
  const target = dummy("b", NEAR);
  const before = { x: guest.local.x, y: guest.local.y };
  // The host puts the guest out of reach; the guest pokes before it hears so.
  place("b", { x: SPOTS.b?.x ?? 0, y: 480 });
  expect(guest.local).toMatchObject(before);
  pokeFrom("b", target);
  run(1);
  expect(dummy("a", NEAR).health).toBe(FULL);
  expect(client("a").net.counts.shown).toBe(0);
  expect(guest.local.y).toBeCloseTo(480, 0);
  place("b", before);
  run(Math.max(POKE.cooldown, 1));
  pokeFrom("b", target);
  run(1);
  expect(dummy("a", NEAR).health).toBe(FULL - POKE.damage);
  expect(client("a").net.counts.shown).toBe(1);
});
