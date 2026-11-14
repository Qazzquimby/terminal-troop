import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { isAreaFree, updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import { teleport } from "./crew.js";
import {
  createHub,
  createManualClock,
  tenth,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

/** One blind zombie, so only what it hears moves it off its wander. */
const entities = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 1 },
  },
};

/** Where a zombie investigates, as its snapshot carries it. */
const Investigating = z.object({
  noiseTarget: z.object({ x: z.number(), y: z.number() }).nullable(),
});

const still: Controls = {
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

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function steps(room: Room, controls: Controls, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(sessionOf(room), controls, DT);
}

/** Steps and frames each of `rooms` with its controls, `seconds` of steps on one clock. */
function together(
  clock: ReturnType<typeof createManualClock>,
  rooms: readonly (readonly [Room, Controls])[],
  seconds: number,
): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    for (const [room, controls] of rooms) {
      updateSession(sessionOf(room), controls, DT);
      room.frame(clock.now());
    }
    clock.advance(clock.now() + DT * 1000);
  }
}

function zombieOf(room: Room): WorldEntity {
  const [zombie] = sessionOf(room).entities.values();
  if (zombie === undefined) throw new Error("no zombie");
  return zombie;
}

const noiseTarget = (room: Room): Point | null =>
  Investigating.parse(zombieOf(room).data).noiseTarget;

/** A spot `distance` from `from` where a player fits. */
function freeSpotNear(game: Session, from: Point, distance: number): Point {
  for (let turn = 0; turn < 16; turn++) {
    const angle = (turn / 16) * Math.PI * 2;
    const x = from.x + Math.cos(angle) * distance;
    const y = from.y + Math.sin(angle) * distance;
    if (isAreaFree(game.world.map, x, y, testSimConfig.player.radius + 10))
      return { x, y };
  }
  throw new Error("no free spot");
}

test("a zombie drawn by a remote player's sprinting keeps investigating when the host changes", async () => {
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
      content: entityContent(entities),
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("NOISE", "A");
  await b.join("NOISE", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");

  // The host puts b there, and b's own client takes it from the host's snapshots.
  const spot = freeSpotNear(sessionOf(b), zombieOf(a), 250);
  teleport([sessionOf(a), sessionOf(b)], "b", spot);
  together(
    clock,
    [
      [a, still],
      [b, still],
    ],
    0.5,
  );
  const sprint = { ...still, move: { x: 1, y: 0 }, sprint: true };
  together(
    clock,
    [
      [a, still],
      [b, sprint],
    ],
    2 * DT,
  );
  together(
    clock,
    [
      [a, still],
      [b, still],
    ],
    1,
  );

  const heard = noiseTarget(a);
  if (heard === null) throw new Error("the zombie heard nothing");
  expect(Math.hypot(heard.x - spot.x, heard.y - spot.y)).toBeLessThan(
    250 * testSimConfig.noise.blur + 10,
  );
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });

  await a.leave();
  clock.advance(3000);
  expect(b.hostId()).toBe("b");
  const before = Math.hypot(zombieOf(b).x - heard.x, zombieOf(b).y - heard.y);
  steps(b, still, 1);
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });
  expect(
    Math.hypot(zombieOf(b).x - heard.x, zombieOf(b).y - heard.y),
  ).toBeLessThan(before);
});
