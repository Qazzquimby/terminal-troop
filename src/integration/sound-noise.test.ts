import { expect, test, vi } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import {
  defineEntity,
  makeSound,
  sound,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

/** No chasers, so nothing but the bell makes noise. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
  },
};

const RING = sound({ url: "ring.mp3", noise: 300 });
const Bell = z.object({ rings: z.number().int().min(0) });

/** A bell that rings, on every client, each time its count goes up. */
const bell = defineEntity("bell", () => ({
  radius: 10,
  maxHealth: 1,
  data: Bell,
  update: (_entity, data) => data,
  cue(entity, previous, next, game) {
    if (next.rings > previous.rings)
      makeSound(game, RING, { x: entity.x, y: entity.y }, entity.id);
  },
  draw: () => undefined,
})).create({ bell: {} });

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Two clients joined to one room over JSON, `a` hosting. */
async function pair() {
  const hub = createHub();
  const clock = createManualClock();
  const client = (id: string): Room =>
    createRoom({
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
      content: [...entityContent(entities), bell],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("SOUND", "A");
  await b.join("SOUND", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  return { a, b, clock };
}

/** Runs one send tick on every room in turn, then one step of each. */
function exchange(
  clock: ReturnType<typeof createManualClock>,
  rooms: Room[],
): void {
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  for (const room of rooms) room.frame(clock.now());
  for (const room of rooms) updateSession(sessionOf(room), still, DT);
}

/** The noises each room heard in its latest step. */
const noises = (rooms: Room[]) =>
  rooms.map((room) => sessionOf(room).noises.length);

test("a sound every client plays from a cue makes one noise, from the host", async () => {
  const { a, b, clock } = await pair();
  const host = sessionOf(a);
  const guest = sessionOf(b);
  const played = [vi.spyOn(host.sfx, "play"), vi.spyOn(guest.sfx, "play")];
  const ringer = spawnEntity(host, "bell", 200, 200, { rings: 0 });
  exchange(clock, [a, b]);
  expect(guest.entities.has(ringer.id)).toBe(true);

  ringer.data = { rings: 1 };
  const heard: number[][] = [];
  for (let frame = 0; frame < 4; frame++) {
    exchange(clock, [a, b]);
    heard.push(noises([a, b]));
  }

  for (const play of played)
    expect(play.mock.calls.map(([url]) => url)).toEqual(["ring.mp3"]);
  expect(heard.flat().filter((count) => count > 0)).toEqual([1, 1]);
  expect(heard.find((counts) => counts.some((count) => count > 0))).toEqual([
    1, 1,
  ]);
  expect(host.noises).toEqual([]);
});

test("a sound the host makes is heard once by every client; one a guest makes, by none", async () => {
  const { a, b, clock } = await pair();
  const host = sessionOf(a);
  const guest = sessionOf(b);

  makeSound(host, RING, { x: 50, y: 60 });
  exchange(clock, [a, b]);
  expect(noises([a, b])).toEqual([1, 1]);
  expect(guest.noises).toEqual([{ at: { x: 50, y: 60 }, radius: 300 }]);

  makeSound(guest, RING, { x: 50, y: 60 });
  for (let frame = 0; frame < 3; frame++) {
    exchange(clock, [a, b]);
    expect(noises([a, b])).toEqual([0, 0]);
  }
});
