import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import type { Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testEntitiesConfig, testSfx, testSimConfig } from "./sim-config.js";

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Lets a join started from a message handler finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Pages on one JSON hub, each with a transport of its own named `page`; each takes ids
 * "<id>-1", "<id>-2", … when told to renew.
 */
function pages() {
  const hub = createHub();
  const clock = createManualClock();
  const open = (id: string, page = id): Room => {
    let renewals = 0;
    return createRoom({
      localId: id,
      renewId: () => `${id}-${String(++renewals)}`,
      world: "dev",
      transport: hub.transport(page, []).port,
      voice: createNullVoice({ mode: "open", muted: false, volume: 1 }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: entityContent(testEntitiesConfig),
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  };
  return { open, clock };
}

const ids = (room: Room): string[] =>
  [...sessionOf(room).players.keys()].sort();

test("a page joining under an id already in the room takes a fresh one; the page there first keeps it", async () => {
  const { open, clock } = pages();
  const first = open("x");
  await first.join("DUP", "A");
  clock.advance(10_000);

  const copy = open("x", "copy");
  await copy.join("DUP", "B");
  await settle();
  clock.advance(1000);

  expect(sessionOf(first).localId).toBe("x");
  expect(sessionOf(copy).localId).toBe("x-1");
  expect(ids(first)).toEqual(["x", "x-1"]);
  expect(ids(copy)).toEqual(["x", "x-1"]);
  expect(first.presenceOf("x-1")?.kind).toBe("present");
  expect(copy.presenceOf("x")?.kind).toBe("present");
});

test("two pages joining under one id at once end up with different ids", async () => {
  const { open, clock } = pages();
  const a = open("x");
  const b = open("x", "b");
  await a.join("DUP", "A");
  await b.join("DUP", "B");
  await settle();
  clock.advance(1000);

  const both = [sessionOf(a).localId, sessionOf(b).localId];
  expect(new Set(both).size).toBe(2);
  expect(ids(a)).toEqual([...both].sort());
  expect(ids(b)).toEqual([...both].sort());
});

test("a reloaded host comes back as the same player, and the others keep the world running", async () => {
  const { open, clock } = pages();
  const host = open("h");
  const other = open("z");
  await host.join("BACK", "H");
  await other.join("BACK", "Z");
  clock.advance(1000);
  expect(other.hostId()).toBe("h");
  host.frame(clock.now());
  const entities = sessionOf(other).entities.size;
  expect(entities).toBeGreaterThan(0);

  await host.leave();
  const reloaded = open("h", "reloaded");
  await reloaded.join("BACK", "H");
  clock.advance(1000);

  expect(other.presenceOf("h")?.kind).toBe("present");
  expect(ids(other)).toEqual(["h", "z"]);
  expect(other.hostId()).toBe("z");
  expect(reloaded.hostId()).toBe("z");
  expect(sessionOf(reloaded).hosting).toBe(false);
  expect(sessionOf(other).entities.size).toBe(entities);
  other.frame(clock.now());
  expect(sessionOf(reloaded).entities.size).toBe(entities);
});

test("a reloaded guest comes back as the same player, with no copy left behind", async () => {
  const { open, clock } = pages();
  const host = open("h");
  const guest = open("z");
  await host.join("BACK", "H");
  await guest.join("BACK", "Z");
  clock.advance(1000);

  await guest.leave();
  const reloaded = open("z", "reloaded");
  await reloaded.join("BACK", "Z");
  clock.advance(1000);

  expect(host.presenceOf("z")?.kind).toBe("present");
  expect(ids(host)).toEqual(["h", "z"]);
  expect(host.hostId()).toBe("h");
  expect(reloaded.hostId()).toBe("h");
});
