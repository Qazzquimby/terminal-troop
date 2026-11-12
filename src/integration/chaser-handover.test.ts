import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { entitySnapshot, updateSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  tenth,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

/** Blind chasers, so they only wander and bark, whoever runs them. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 4 },
  },
};

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

/** What these tests read of a chaser's state as it travels. */
const Chaser = z.object({ barkAt: z.number(), barks: z.number() });

/** Each chaser `room` holds, by id: where it is headed and its state as it travels. */
function chasers(room: Room) {
  const { entities } = sessionOf(room);
  return new Map(
    entitySnapshot(sessionOf(room))
      .filter(({ data }) => Chaser.safeParse(data).success)
      .map(({ id, data }) => {
        const entity = entities.get(id);
        return [
          id,
          { x: tenth(entity?.tx ?? NaN), y: tenth(entity?.ty ?? NaN), data },
        ];
      }),
  );
}

const barks = (room: Room): number[] =>
  [...chasers(room).values()].map(({ data }) => Chaser.parse(data).barks);

test("a new host runs each chaser on from the last snapshot, under the same id, its timers kept", async () => {
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
  const c = client("c");
  const rooms = [a, b, c];
  for (const [index, room] of rooms.entries())
    await room.join("HANDOVER", String(index));
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
  play(testRoomConfig.fullSnapshotMs / 1000 + 2);

  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  a.frame(clock.now());
  const last = chasers(a);
  expect(last.size).toBe(4);
  expect([...last.keys()]).toEqual(["1", "2", "3", "4"]);
  expect(chasers(b)).toEqual(last);
  expect(sessionOf(b).worldTime).toBeCloseTo(sessionOf(a).worldTime, 2);
  const barked = barks(b);

  await a.leave();
  rooms.splice(0, 1);
  clock.advance(clock.now() + 3000);
  expect(b.hostId()).toBe("b");
  expect(chasers(b)).toEqual(last);
  for (const { data } of last.values())
    expect(Chaser.parse(data).barkAt).toBeGreaterThan(sessionOf(b).worldTime);

  play(entities.chaser.barkGap.max + 1);
  expect([...chasers(b).keys()]).toEqual([...last.keys()]);
  expect(chasers(b)).not.toEqual(last);
  for (const [index, count] of barks(b).entries())
    expect(count).toBeGreaterThan(barked[index] ?? Infinity);
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  b.frame(clock.now());
  expect(chasers(c)).toEqual(chasers(b));
});
