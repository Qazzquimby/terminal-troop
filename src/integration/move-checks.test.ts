import { expect, test } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { correctPlayer, hurtPlayer, updateSession } from "../sim/index.js";
import type {
  Controls,
  Point,
  Session,
  SimConfig,
  WorldContent,
} from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  testRoomConfig,
} from "./room-helpers.js";
import { testMovesConfig, testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const { settleSeconds, roundTripSeconds } = testSimConfig.net.moves;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};
const sprinting = (x: number, y: number): Controls => ({
  ...idle,
  move: { x, y },
  sprint: true,
});

/** Where the host's player stands, out of the way. */
const HOST = { x: 150, y: 500 };
/** Where the guest's player starts, with open floor to its right. */
const GUEST = { x: 100, y: 300 };
/** Open floor far from GUEST. */
const FAR = { x: 700, y: 300 };

/**
 * A transport that counts the corrections it sends, and can hold what it sends until released
 * all at once.
 */
function watched(port: Transport) {
  let held: [NetEvent, unknown][] | null = null;
  let corrections = 0;
  const send: Transport["send"] = (event, payload) => {
    for (const message of messages(event, payload)) {
      if (
        message.event === NetEvent.CONTENT &&
        JSON.stringify(message.payload).includes('"core/position"')
      )
        corrections++;
    }
    if (held === null) return port.send(event, payload);
    held.push([event, payload]);
    return Promise.resolve();
  };
  return {
    port: { ...port, send },
    corrections: () => corrections,
    hold(): void {
      held = [];
    },
    release(): void {
      const sends = held ?? [];
      held = null;
      for (const [event, payload] of sends) void port.send(event, payload);
    },
  };
}

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

interface Client {
  readonly room: Room;
  readonly net: ReturnType<typeof watched>;
  readonly game: () => Session;
}

/**
 * Clients joined in order to one room on a JSON hub, the first hosting, each standing where
 * `starts` puts it, and stepped until the settle time after joining has passed.
 */
async function room(
  starts: Readonly<Record<string, Point>>,
  sim: SimConfig = testSimConfig,
  content: readonly WorldContent[] = [],
) {
  const hub = createHub();
  const clock = createManualClock();
  const clients = new Map<string, Client>();
  for (const id of Object.keys(starts)) {
    const net = watched(hub.transport(id, []).port);
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
      sim,
      content,
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await joined.join("PACE", id.toUpperCase());
    clients.set(id, { room: joined, net, game: () => sessionOf(joined) });
  }
  clock.advance(clock.now() + 1000);
  const client = (id: string): Client => {
    const found = clients.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return found;
  };
  for (const [id, at] of Object.entries(starts)) standAt(client(id).game(), at);

  /** Clients that neither step nor send frames, as a hidden page does. */
  const paused = new Set<string>();
  /**
   * Steps every client but those paused once, `controls` by id or standing still, each sending
   * its frame after its step; then lets a step's time pass.
   */
  function step(controls: Readonly<Record<string, Controls>> = {}): void {
    for (const [id, { room: joined, game }] of clients) {
      if (paused.has(id) || joined.state().kind !== "joined") continue;
      updateSession(game(), controls[id] ?? idle, DT);
      joined.frame(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
  }
  /** Steps `seconds` as `step` does. */
  function run(
    seconds: number,
    controls: Readonly<Record<string, Controls>> = {},
  ): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step(controls);
  }
  run(settleSeconds + 0.5);
  return { client, paused, step, run };
}

/** The player `id` as `client` knows it. */
function playerOn(client: Client, id: string) {
  const player = client.game().players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

/** Expects `client` to see player `id` standing at `at`, and that player to stand there. */
function expectAt(client: Client, mover: Client, at: Point): void {
  const { local } = mover.game();
  expect(local.x).toBeCloseTo(at.x, 0);
  expect(local.y).toBeCloseTo(at.y, 0);
  const seen = playerOn(client, local.id);
  expect(seen.tx).toBeCloseTo(at.x, 0);
  expect(seen.ty).toBeCloseTo(at.y, 0);
}

test("walking and sprinting about, around a pillar's corner and along walls, are never corrected", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  run(1.2, { b: sprinting(1, 0) });
  run(1, { b: { ...idle, move: { x: 0, y: -1 } } });
  run(1.5, { b: sprinting(-1, 0) });
  run(1, { b: sprinting(-Math.SQRT1_2, Math.SQRT1_2) });
  run(1, { b: { ...idle, move: { x: -1, y: 0 } } });
  run(1, { b: sprinting(0, 1) });
  run(1);
  const guest = client("b").game().local;
  expect(client("a").net.corrections()).toBe(0);
  expectAt(client("a"), client("b"), guest);
});

test("a guest that jumps far across open floor is put back where it last stood", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  standAt(client("b").game(), FAR);
  run(0.5);
  expect(client("a").net.corrections()).toBe(1);
  expectAt(client("a"), client("b"), GUEST);
});

test("a guest that steps through a pillar is put back, and the same step in the open is not", async () => {
  const sides = { west: { x: 175, y: 100 }, east: { x: 325, y: 100 } };
  const open = { west: { x: 175, y: 300 }, east: { x: 325, y: 300 } };
  for (const [ways, corrected] of [
    [sides, true],
    [open, false],
  ] as const) {
    const { client, run, step } = await room({ a: HOST, b: ways.west });
    const host = client("a").game();
    // The last report taken is old enough for the step's length to be within reach.
    while (host.time - (host.moveChecks.get("b")?.time ?? 0) < 0.5) step();
    standAt(client("b").game(), ways.east);
    run(0.5);
    expect(client("a").net.corrections()).toBe(corrected ? 1 : 0);
    expectAt(client("a"), client("b"), corrected ? ways.west : ways.east);
  }
});

test("a long kick lunge is allowed", async () => {
  const lunge = { lengths: 10, seconds: 0.1 };
  const moves = { kick: { ...testMovesConfig.kick, lunge } };
  const sim = {
    ...testSimConfig,
    net: { ...testSimConfig.net, useSlack: { distance: 400, seconds: 0.1 } },
  };
  const { client, step, run } = await room(
    { a: HOST, b: GUEST },
    sim,
    moveContent(moves),
  );
  const guest = client("b").game().local;
  step({ b: { ...idle, secondary: true, aim: { x: 1000, y: GUEST.y } } });
  run(1);
  expect(guest.x - GUEST.x).toBeGreaterThan(testSimConfig.player.radius * 19);
  expect(client("a").net.corrections()).toBe(0);
  expectAt(client("a"), client("b"), guest);
});

test("a long knockback from the host is allowed", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  hurtPlayer(client("a").game(), playerOn(client("a"), "b"), 0, {
    from: { x: GUEST.x - 10, y: GUEST.y },
    distance: 300,
  });
  run(1);
  expect(client("a").net.corrections()).toBe(0);
  expectAt(client("a"), client("b"), { x: GUEST.x + 300, y: GUEST.y });
});

test("a guest that comes back to its page far from where it hid is taken there", async () => {
  const { client, paused, run } = await room({ a: HOST, b: GUEST });
  client("b").room.setHidden(true);
  paused.add("b");
  run(0.5);
  standAt(client("b").game(), FAR);
  paused.delete("b");
  client("b").room.setHidden(false);
  run(0.5);
  expect(client("a").net.corrections()).toBe(0);
  expectAt(client("a"), client("b"), FAR);
});

test("a new host takes each player's reports as they come at first, then checks them", async () => {
  const { client, run } = await room({
    a: HOST,
    b: GUEST,
    c: { x: 450, y: 300 },
  });
  await client("a").room.leave();
  run(1.5);
  expect(client("b").room.hostId()).toBe("b");
  expect(client("c").room.hostId()).toBe("b");
  standAt(client("c").game(), FAR);
  run(0.5);
  expect(client("b").net.corrections()).toBe(0);
  expectAt(client("b"), client("c"), FAR);

  run(settleSeconds);
  standAt(client("c").game(), GUEST);
  run(0.5);
  expect(client("b").net.corrections()).toBe(1);
  expectAt(client("b"), client("c"), FAR);
});

test("reports a guest sent before its correction are held, not corrected again", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  const there = { x: 400, y: 400 };
  client("b").net.hold();
  run(0.3, { b: sprinting(1, 0) });
  correctPlayer(client("a").game(), playerOn(client("a"), "b"), there);
  client("b").net.release();
  expect(playerOn(client("a"), "b").tx).toBe(there.x);
  run(roundTripSeconds + 0.5);
  expect(client("a").net.corrections()).toBe(1);
  expectAt(client("a"), client("b"), there);
});

test("reports that arrive late, or several at once, are not corrected", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  const guest = client("b").net;
  for (const [late, sprint] of [
    [0.5, sprinting(1, 0)],
    [0.05, sprinting(0, -1)],
    [0.3, sprinting(-1, 0)],
    [0.1, sprinting(0, 1)],
    [0.4, sprinting(1, 0)],
  ] as const) {
    guest.hold();
    run(late, { b: sprint });
    guest.release();
    run(0.1, { b: sprint });
  }
  run(0.5);
  expect(client("a").net.corrections()).toBe(0);
  expectAt(client("a"), client("b"), client("b").game().local);
});
