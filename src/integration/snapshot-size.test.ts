import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const CHASERS = 60;

/** Blind chasers, as many as a real world holds, wandering and barking. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: CHASERS },
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

const Snapshot = z.object({
  full: z.boolean(),
  entities: z.array(z.object({ id: z.string() })),
  changed: z.array(z.unknown()),
});

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

test("between full snapshots, an idle host sends a few dozen bytes a chaser", async () => {
  const hub = createHub();
  const clock = createManualClock();
  /** Each entity snapshot the host sent: whether full, its size as JSON, and its entity ids. */
  const sent: { full: boolean; bytes: number; ids: string[] }[] = [];
  const port = hub.transport("host", []).port;
  const recording: Transport = {
    ...port,
    send(event, payload) {
      for (const message of messages(event, payload)) {
        if (message.event !== NetEvent.ENTITIES) continue;
        const snapshot = Snapshot.parse(message.payload);
        sent.push({
          full: snapshot.full,
          bytes: JSON.stringify(message.payload).length,
          ids: snapshot.entities.map(({ id }) => id),
        });
      }
      return port.send(event, payload);
    },
  };
  const host = createRoom({
    localId: "host",
    world: "standard",
    transport: recording,
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
  await host.join("SIZES", "H");
  clock.advance(1000);
  for (let step = 0; step < 4 / DT; step++) {
    updateSession(sessionOf(host), still, DT);
    clock.advance(clock.now() + 1000 * DT);
    host.frame(clock.now());
  }

  const [first] = sent;
  expect(first?.full).toBe(true);
  expect(first?.ids.length).toBe(CHASERS + 1);
  expect(Math.max(...(first?.ids.map((id) => id.length) ?? []))).toBe(2);
  const deltas = sent.filter(({ full }) => !full);
  expect(deltas.length).toBeGreaterThan(40);
  let total = 0;
  for (const { bytes } of deltas) total += bytes;
  expect(total / deltas.length / CHASERS).toBeLessThan(50);
});
