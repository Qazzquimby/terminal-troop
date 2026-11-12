import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createPositionMemory } from "../position-memory/index.js";
import type {
  PositionMemory,
  PositionStorage,
} from "../position-memory/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { createSession, isAreaFree } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  tenth,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const SPREAD = testSimConfig.arrival.spread;

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Clients on one hub, each a page keeping where its player stands in its own storage. */
function pages() {
  const hub = createHub();
  const clock = createManualClock();
  return {
    clock,
    open: (
      id: string,
      storage: PositionStorage,
    ): { room: Room; positions: PositionMemory } => {
      const positions = createPositionMemory(
        { saveInterval: 1, maxRooms: 5 },
        storage,
      );
      const room = createRoom({
        localId: id,
        world: "standard",
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
        content: entityContent(testEntitiesConfig),
        falloff: { full: 100, silent: 600, pan: 300 },
        savedPosition: (place) => positions.enter(place),
        onChange: () => undefined,
        onPeerFailed: () => undefined,
      });
      return { room, positions };
    },
  };
}

function browserStorage(): PositionStorage {
  const saved = new Map<string, string>();
  return {
    get: (key) => saved.get(key) ?? null,
    set: (key, value) => {
      saved.set(key, value);
    },
  };
}

const CRUISER = 2;

function cruiserOf(game: Session): Point {
  const cruiser = [...game.entities.values()].find(
    (entity) => entity.kind === CRUISER,
  );
  if (cruiser === undefined) throw new Error("no cruiser");
  return { x: cruiser.x, y: cruiser.y };
}

test("the cruiser stands at the same seeded spot on every client, wherever their players start", () => {
  const first = createSession(
    "a",
    "A",
    "CAR",
    "standard",
    testSfx(),
    testSimConfig,
  );
  const second = createSession(
    "b",
    "B",
    "CAR",
    "standard",
    testSfx(),
    testSimConfig,
    {
      at: { x: first.rally.x + 60, y: first.rally.y },
    },
  );
  for (const game of [first, second]) {
    for (const entry of entityContent(testEntitiesConfig)) entry.register(game);
    for (const entry of entityContent(testEntitiesConfig)) entry.populate(game);
  }
  expect(cruiserOf(second)).toEqual(cruiserOf(first));
  expect(cruiserOf(first)).toEqual(first.rally);
});

test("both players first join by the cruiser, apart", async () => {
  const { open, clock } = pages();
  const a = open("a", browserStorage()).room;
  const b = open("b", browserStorage()).room;
  await a.join("CAR", "A");
  await b.join("CAR", "B");
  clock.advance(1000);
  a.frame(clock.now());
  b.frame(clock.now());

  const cruiser = cruiserOf(sessionOf(b));
  const { rally } = sessionOf(a);
  // The cruiser reaches b as the host sent it, to a tenth of a pixel.
  expect(cruiser).toEqual({ x: tenth(rally.x), y: tenth(rally.y) });
  for (const room of [a, b]) {
    const { local, world } = sessionOf(room);
    expect(distance(local, cruiser)).toBeLessThanOrEqual(SPREAD);
    expect(isAreaFree(world.map, local.x, local.y, local.radius)).toBe(true);
  }
  expect(distance(sessionOf(a).local, sessionOf(b).local)).toBeGreaterThan(0);
});

test("a reload puts the player back where it stood; another room puts it by the cruiser", async () => {
  const { open } = pages();
  const storage = browserStorage();
  const { room: before, positions } = open("a", storage);
  await before.join("HOME", "A");
  const home = sessionOf(before);
  positions.save(home.local, 0);
  const walked = { x: home.rally.x, y: home.rally.y };
  let step = 0;
  while (distance(walked, home.rally) < SPREAD * 2) {
    const next = { x: walked.x + 10, y: walked.y };
    if (!isAreaFree(home.world.map, next.x, next.y, home.local.radius)) break;
    walked.x = next.x;
    step++;
  }
  expect(step).toBeGreaterThan(0);
  Object.assign(home.local, walked);
  positions.save(home.local, 0);
  await before.leave();
  positions.flush();

  const reloaded = open("a", storage).room;
  await reloaded.join("HOME", "A");
  expect(sessionOf(reloaded).local).toMatchObject(walked);

  await reloaded.join("AWAY", "A");
  const away = sessionOf(reloaded);
  expect(distance(away.local, away.rally)).toBeLessThanOrEqual(SPREAD);
});
