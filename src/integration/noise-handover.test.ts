import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { isAreaFree, updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  tenth,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

/** One blind chaser, so only what it hears moves it off its wander. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 1 },
  },
};

/** Where a chaser investigates, as its snapshot carries it. */
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

function chaserOf(room: Room): WorldEntity {
  const [chaser] = sessionOf(room).entities.values();
  if (chaser === undefined) throw new Error("no chaser");
  return chaser;
}

const noiseTarget = (room: Room): Point | null =>
  Investigating.parse(chaserOf(room).data).noiseTarget;

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

test("a chaser drawn by a remote player's sprinting keeps investigating when the host changes", async () => {
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

  const spot = freeSpotNear(sessionOf(b), chaserOf(a), 250);
  Object.assign(sessionOf(b).local, { ...spot, prevX: spot.x, prevY: spot.y });
  steps(b, { ...still, move: { x: 1, y: 0 }, sprint: true }, DT);
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  b.frame(clock.now());
  steps(a, still, 1);
  a.frame(clock.now());

  const heard = noiseTarget(a);
  if (heard === null) throw new Error("the chaser heard nothing");
  expect(Math.hypot(heard.x - spot.x, heard.y - spot.y)).toBeLessThan(
    250 * testSimConfig.noise.blur + 10,
  );
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });

  await a.leave();
  clock.advance(3000);
  expect(b.hostId()).toBe("b");
  const before = Math.hypot(chaserOf(b).x - heard.x, chaserOf(b).y - heard.y);
  steps(b, still, 1);
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });
  expect(
    Math.hypot(chaserOf(b).x - heard.x, chaserOf(b).y - heard.y),
  ).toBeLessThan(before);
});
