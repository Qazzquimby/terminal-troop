import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

/** No starting chasers, and blind ones, so only spawning adds them and none runs anyone down. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
  },
};
const { spawning } = entities.chaser;

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

function chasers(room: Room): number {
  const game = sessionOf(room);
  const kind = game.kindIds.get("chaser");
  return [...game.entities.values()].filter((entity) => entity.kind === kind)
    .length;
}

test("a new host goes on along the spawning ramp rather than starting it again", async () => {
  const hub = createHub();
  const clock = createManualClock();
  const client = (id: string): Room =>
    createRoom({
      localId: id,
      world: "standard",
      transport: hub.transport(id, []).port,
      voice: createNullVoice({
        mode: "open",
        muted: false,
        volume: 1,
        inputDevice: null,
      }),
      sfx: { ...testSfx(), play: () => new Promise(() => undefined) },
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
  const rooms = [a, b];
  for (const [index, room] of rooms.entries())
    await room.join("RAMP", String(index));
  /** Runs `seconds` on every room still in, each frame letting it send. */
  const play = (seconds: number): void => {
    for (let step = 0; step < Math.round(seconds / DT); step++) {
      for (const room of rooms) {
        if (room.state().kind !== "joined") continue;
        updateSession(sessionOf(room), still, DT);
      }
      clock.advance(clock.now() + 1000 * DT);
      for (const room of rooms) room.frame(clock.now());
    }
  };
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  play(spawning.rampSeconds + 1);
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  a.frame(clock.now());
  const before = chasers(b);
  expect(before).toBeGreaterThan(0);
  expect(before).toBe(chasers(a));

  await a.leave();
  rooms.splice(0, 1);
  clock.advance(clock.now() + 3000);
  expect(b.hostId()).toBe("b");

  // Spawning started again would wait out the first gap; at the ramp's end they come each last gap.
  play(spawning.firstGap - spawning.lastGap);
  expect(chasers(b)).toBeGreaterThanOrEqual(
    before +
      Math.floor((spawning.firstGap - spawning.lastGap) / spawning.lastGap) -
      1,
  );
});
