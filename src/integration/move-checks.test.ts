import { expect, test } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
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
  delayed,
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

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** How a client is driven each step: steady controls, or controls worked out from its session. */
type Drive = Controls | ((game: Session) => Controls);

/** Delivery 60 to 180ms after sending, varying from one send to the next. */
function jitter(): () => number {
  let sends = 0;
  return () => 60 + ((sends++ * 37) % 120);
}

interface Client {
  readonly room: Room;
  readonly net: ReturnType<typeof delayed>;
  readonly game: () => Session;
}

/**
 * Clients joined in order to one room on a JSON hub, the first hosting, each standing where
 * `starts` puts it, each send arriving `delayMs()` later, and stepped until the settle time after
 * joining has passed.
 */
async function room(
  starts: Readonly<Record<string, Point>>,
  sim: SimConfig = testSimConfig,
  content: readonly WorldContent[] = [],
  delayMs: () => number = () => 0,
) {
  const hub = createHub();
  const clock = createManualClock();
  const clients = new Map<string, Client>();
  for (const id of Object.keys(starts)) {
    const net = delayed(hub.transport(id, []).port, delayMs);
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
    net.stamp(clock.now());
    net.flush(Infinity);
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
  /** Clients that cheat, going this many times as far each step as their own rules move them. */
  const fast = new Map<string, number>();
  /**
   * Steps every client but those paused once, driven by `controls` by id or standing still, each
   * sending its frame after its step; then lets a step's time pass.
   */
  function step(controls: Readonly<Record<string, Drive>> = {}): void {
    for (const [id, { room: joined, net, game }] of clients) {
      if (paused.has(id) || joined.state().kind !== "joined") continue;
      const session = game();
      const { local } = session;
      const drive = controls[id] ?? idle;
      const from = { x: local.x, y: local.y };
      updateSession(
        session,
        typeof drive === "function" ? drive(session) : drive,
        DT,
      );
      const times = fast.get(id) ?? 1;
      local.x = from.x + (local.x - from.x) * times;
      local.y = from.y + (local.y - from.y) * times;
      joined.frame(clock.now());
      net.stamp(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
    for (const { net } of clients.values()) net.flush(clock.now());
  }
  /** Steps `seconds` as `step` does. */
  function run(
    seconds: number,
    controls: Readonly<Record<string, Drive>> = {},
  ): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step(controls);
  }
  run(settleSeconds + 0.5);
  /** Delivers everything `id` sent while held, all at once. */
  const release = (id: string): void => {
    client(id).net.release(clock.now());
  };
  return { client, paused, fast, step, run, release };
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
  expect(client("a").net.counts.corrections).toBe(0);
  expectAt(client("a"), client("b"), guest);
});

test("a guest that jumps far across open floor is put back where it last stood", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  standAt(client("b").game(), FAR);
  run(0.5);
  expect(client("a").net.counts.corrections).toBe(1);
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
    while (
      host.time - (host.moveChecks.get("b")?.marks.at(-1)?.time ?? 0) <
      0.5
    )
      step();
    standAt(client("b").game(), ways.east);
    run(0.5);
    expect(client("a").net.counts.corrections).toBe(corrected ? 1 : 0);
    expectAt(client("a"), client("b"), corrected ? ways.west : ways.east);
  }
});

test.each([
  ["at once", () => () => 0],
  ["with jitter", jitter],
])("a long kick lunge is allowed, delivered %s", async (_, delays) => {
  const lunge = { ...testMovesConfig.kick.lunge, lengths: 10 };
  const moves = { kick: { ...testMovesConfig.kick, lunge } };
  const sim = {
    ...testSimConfig,
    net: { ...testSimConfig.net, useSlack: { seconds: 0.1 } },
  };
  const { client, step, run } = await room(
    { a: HOST, b: GUEST },
    sim,
    moveContent(moves),
    delays(),
  );
  const guest = client("b").game().local;
  step({ b: { ...idle, secondary: true, aim: { x: 1000, y: GUEST.y } } });
  run(1);
  expect(guest.x - GUEST.x).toBeGreaterThan(testSimConfig.player.radius * 19);
  expect(client("a").net.counts.corrections).toBe(0);
  expectAt(client("a"), client("b"), guest);
});

test.each([
  ["at once", () => () => 0],
  ["with jitter", jitter],
])(
  "a long knockback from the host is allowed, delivered %s",
  async (_, delays) => {
    const { client, run } = await room(
      { a: HOST, b: GUEST },
      testSimConfig,
      [],
      delays(),
    );
    hurtPlayer(client("a").game(), playerOn(client("a"), "b"), 0, {
      from: { x: GUEST.x - 10, y: GUEST.y },
      distance: 300,
    });
    run(1);
    expect(client("a").net.counts.corrections).toBe(0);
    expectAt(client("a"), client("b"), { x: GUEST.x + 300, y: GUEST.y });
  },
);

test("a guest that comes back to its page far from where it hid is taken there", async () => {
  const { client, paused, run } = await room({ a: HOST, b: GUEST });
  client("b").room.setHidden(true);
  paused.add("b");
  run(0.5);
  standAt(client("b").game(), FAR);
  paused.delete("b");
  client("b").room.setHidden(false);
  run(0.5);
  expect(client("a").net.counts.corrections).toBe(0);
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
  expect(client("b").net.counts.corrections).toBe(0);
  expectAt(client("b"), client("c"), FAR);

  run(settleSeconds);
  standAt(client("c").game(), GUEST);
  run(0.5);
  expect(client("b").net.counts.corrections).toBe(1);
  expectAt(client("b"), client("c"), FAR);
});

test("reports a guest sent before its correction are ignored, not corrected again", async () => {
  const { client, run, release } = await room({ a: HOST, b: GUEST });
  const there = { x: 400, y: 400 };
  client("b").net.hold();
  run(0.3, { b: sprinting(1, 0) });
  correctPlayer(client("a").game(), playerOn(client("a"), "b"), there);
  release("b");
  expect(playerOn(client("a"), "b").tx).toBe(there.x);
  run(roundTripSeconds + 0.5);
  expect(client("a").net.counts.corrections).toBe(1);
  expectAt(client("a"), client("b"), there);
});

test("reports that arrive late, or several at once, are not corrected", async () => {
  const { client, run, release } = await room({ a: HOST, b: GUEST });
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
    release("b");
    run(0.1, { b: sprint });
  }
  run(0.5);
  expect(client("a").net.counts.corrections).toBe(0);
  expectAt(client("a"), client("b"), client("b").game().local);
});

/**
 * Sprinting towards each of `waypoints` in turn, round and round, moving on to the next within
 * 20px of one or after `patience` seconds.
 */
function touring(waypoints: readonly Point[], patience: number) {
  let next = 0;
  let since = 0;
  return (game: Session): Controls => {
    const { x, y } = game.local;
    const at = (): Point => waypoints[next % waypoints.length] ?? GUEST;
    since += DT;
    if (Math.hypot(at().x - x, at().y - y) < 20 || since > patience) {
      next++;
      since = 0;
    }
    const length = Math.max(Math.hypot(at().x - x, at().y - y), 1);
    return sprinting((at().x - x) / length, (at().y - y) / length);
  };
}

/**
 * Round the dev square pressed into its walls and corners, then tucked under a pillar and round
 * its corner.
 */
const TOUR = [
  { x: 0, y: 0 },
  { x: 900, y: 0 },
  { x: 900, y: 600 },
  { x: 0, y: 600 },
  { x: 180, y: 170 },
  { x: 340, y: 160 },
  { x: 330, y: 20 },
];

test("an honest guest sprinting round walls and corners for a long while, delivered with jitter, is never corrected", async () => {
  const { client, run } = await room(
    { a: HOST, b: GUEST },
    testSimConfig,
    [],
    jitter(),
  );
  const guest = client("b").game().local;
  let exhausted = false;
  const tour = touring(TOUR, 2.5);
  for (let i = 0; i < 120; i++) {
    run(0.25, { b: tour });
    exhausted ||= guest.stamina.exhausted;
  }
  expect(exhausted).toBe(true);
  expect(client("a").net.counts.corrections).toBe(0);
  run(1);
  expectAt(client("a"), client("b"), guest);
});

test("an honest guest whose reports are each held half a second and then arrive at once is never corrected", async () => {
  const { client, run, release } = await room(
    { a: HOST, b: GUEST },
    testSimConfig,
    [],
    jitter(),
  );
  const tour = touring(TOUR, 2.5);
  for (let i = 0; i < 15; i++) {
    client("b").net.hold();
    run(0.5, { b: tour });
    release("b");
    run(0.3, { b: tour });
  }
  run(1);
  expect(client("a").net.counts.corrections).toBe(0);
  expectAt(client("a"), client("b"), client("b").game().local);
});

test.each([
  [1, false],
  [1.3, true],
  [2, true],
])(
  "a guest sprinting %sx as fast as it may, delivered with jitter, is corrected within about a window: %s",
  async (times, corrected) => {
    const { client, fast, step } = await room(
      { a: HOST, b: { x: 40, y: 300 } },
      testSimConfig,
      [],
      jitter(),
    );
    fast.set("b", times);
    const { windowSeconds } = testSimConfig.net.moves;
    let seconds = 0;
    while (
      seconds < windowSeconds + 0.25 &&
      client("a").net.counts.corrections === 0
    ) {
      step({ b: sprinting(1, 0) });
      seconds += DT;
    }
    expect(client("a").net.counts.corrections > 0).toBe(corrected);
  },
);
