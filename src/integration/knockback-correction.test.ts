import { expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { hurtPlayer, isAreaFree, updateSession } from "../sim/index.js";
import type { Controls, Point, Session } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testItemsConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const { kick } = testMovesConfig;
const { radius, knockbackSeconds } = testSimConfig.player;
const DT = 1 / 60;
const PLAYER_LENGTH = radius * 2;
/** How far a kick sends a player. */
const KICKED = PLAYER_LENGTH * kick.knockback;
/** Steps from a push until well past the host's check of it. */
const PAST_CHECK = Math.ceil(
  (knockbackSeconds + testSimConfig.net.knockback.slack) / DT + 30,
);
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

/** Faces right of where `game`'s local player stands, kicking. */
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

/** A spot clear of walls, with room to its right for a kick and a push. */
const LEFT = { x: 150, y: 300 };
/** Where a kick from LEFT, facing right, lands once its lunge is done. */
const KICK_AT = { x: LEFT.x + PLAYER_LENGTH + kick.reach, y: LEFT.y };
/** Where that kick sends a player standing at KICK_AT. */
const PUSHED_TO = { x: KICK_AT.x + KICKED, y: KICK_AT.y };

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Keeps `game`'s sounds from playing. */
function mute(game: Session): void {
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
}

/**
 * Two clients with the kick, joined to one room on a JSON hub, `a` hosting. Each round steps
 * both clients once and lets 1/60s of room time pass, so both run at the same rate.
 */
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
      content: [
        ...itemContent(testItemsConfig),
        ...moveContent(testMovesConfig),
      ],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("FRIEND", "A");
  await b.join("FRIEND", "B");
  mute(sessionOf(a));
  mute(sessionOf(b));
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  const host = sessionOf(a);
  const guest = sessionOf(b);
  /** Every correction the host has sent. */
  const corrections: unknown[] = [];
  /**
   * One round: the guest steps under `controls.b` and then `afterGuest`, the host under
   * `controls.a`, and both send what they have.
   */
  const round = (
    controls: { a?: Controls; b?: Controls } = {},
    afterGuest: () => void = () => undefined,
  ): void => {
    updateSession(guest, controls.b ?? idle, DT);
    afterGuest();
    b.frame(clock.now());
    updateSession(host, controls.a ?? idle, DT);
    corrections.push(
      ...host.outbox
        .filter(({ content }) => content === "core/position")
        .map(({ payload }) => payload),
    );
    a.frame(clock.now());
    clock.advance(clock.now() + DT * 1000);
  };
  const rounds = (
    count: number,
    controls: () => { a?: Controls; b?: Controls } = () => ({}),
    afterGuest?: () => void,
  ): void => {
    for (let i = 0; i < count; i++) round(controls(), afterGuest);
  };
  /** Puts the host's player at `at` and the guest's at `them`, still, as both know them. */
  const place = (at: Point, them: Point): void => {
    for (const [game, spot, other] of [
      [host, at, guest],
      [guest, them, host],
    ] as const) {
      Object.assign(game.local, { ...spot, prevX: spot.x, prevY: spot.y });
      const seen = other.players.get(game.localId);
      Object.assign(seen ?? {}, { ...spot, tx: spot.x, ty: spot.y });
    }
    rounds(30);
  };
  /** The host kicks right, and rounds run until its kick lands on the guest. */
  const kickGuest = (afterGuest?: () => void): void => {
    round({ a: kickRight(host) }, afterGuest);
    for (let i = 0; i < 10 && !host.knockbacks.has("b"); i++)
      round({}, afterGuest);
    expect(host.knockbacks.has("b")).toBe(true);
  };
  return { host, guest, corrections, round, rounds, place, kickGuest };
}

test("the spots the tests use are clear of walls, push included", async () => {
  const { host } = await pair();
  for (const at of [LEFT, KICK_AT, PUSHED_TO])
    expect(isAreaFree(host.world.map, at.x, at.y, radius)).toBe(true);
});

test("a guest that takes its knockback is not corrected", async () => {
  const { host, guest, corrections, rounds, place, kickGuest } = await pair();
  place(LEFT, KICK_AT);
  kickGuest();
  expect(host.knockbacks.get("b")?.at.x).toBeCloseTo(PUSHED_TO.x);
  expect(host.knockbacks.get("b")?.at.y).toBeCloseTo(PUSHED_TO.y);
  rounds(PAST_CHECK);
  expect(guest.local.health).toBeLessThan(testSimConfig.player.maxHealth);
  expect(guest.local.x).toBeCloseTo(PUSHED_TO.x);
  expect(host.knockbacks.size).toBe(0);
  expect(corrections).toEqual([]);
});

test("a guest that ignores its knockback is put where it would have ended", async () => {
  const { host, guest, corrections, rounds, place, kickGuest } = await pair();
  place(LEFT, KICK_AT);
  const ignore = (): void => {
    guest.local.dash = null;
  };
  kickGuest(ignore);
  rounds(PAST_CHECK, undefined, ignore);
  expect(guest.local.health).toBeLessThan(testSimConfig.player.maxHealth);
  expect(corrections).toHaveLength(1);
  expect(guest.local.x).toBeCloseTo(PUSHED_TO.x);
  expect(guest.local.y).toBeCloseTo(PUSHED_TO.y);
  expect(host.players.get("b")?.tx).toBeCloseTo(PUSHED_TO.x);
});

test.each([
  ["walking", false],
  ["sprinting", true],
])(
  "a guest %s away once its knockback ends is not corrected",
  async (_gait, sprint) => {
    const { guest, corrections, rounds, place, kickGuest } = await pair();
    place(LEFT, KICK_AT);
    kickGuest();
    rounds(2);
    expect(guest.local.dash).not.toBeNull();
    rounds(Math.ceil(knockbackSeconds / DT) + 1);
    expect(guest.local.dash).toBeNull();
    const away = { ...idle, sprint, move: { x: 0, y: 1 } };
    rounds(PAST_CHECK, () => ({ b: away }));
    expect(guest.local.y).toBeGreaterThan(PUSHED_TO.y + 50);
    expect(corrections).toEqual([]);
  },
);

test("a push into a wall is expected to stop at the wall, and is not corrected", async () => {
  const { host, guest, corrections, rounds, place, kickGuest } = await pair();
  const wall = host.world.W;
  const kicker = { x: wall - 100, y: LEFT.y };
  place(kicker, { x: kicker.x + PLAYER_LENGTH + kick.reach, y: kicker.y });
  kickGuest();
  const expected = host.knockbacks.get("b")?.at;
  expect(expected?.x).toBeCloseTo(wall - radius);
  rounds(PAST_CHECK);
  expect(guest.local.x).toBeCloseTo(wall - radius);
  expect(guest.local.x).toBeCloseTo(expected?.x ?? Number.NaN);
  expect(corrections).toEqual([]);
});

test("the host's own player takes its knockback directly, and nothing is expected of it", async () => {
  const { host, guest, corrections, round, rounds, place } = await pair();
  place(KICK_AT, LEFT);
  round({ b: kickRight(guest) });
  rounds(PAST_CHECK);
  expect(host.local.health).toBeLessThan(testSimConfig.player.maxHealth);
  expect(host.local.x).toBeCloseTo(PUSHED_TO.x);
  expect(host.knockbacks.size).toBe(0);
  expect(corrections).toEqual([]);
});

test("a blow with no push, such as a chaser's strike, expects nothing", async () => {
  const { host, corrections, rounds, place } = await pair();
  place(LEFT, KICK_AT);
  const seen = host.players.get("b");
  if (seen === undefined) throw new Error("no guest");
  hurtPlayer(host, seen, 5);
  expect(host.knockbacks.size).toBe(0);
  rounds(PAST_CHECK);
  expect(corrections).toEqual([]);
});
