import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  glideTo,
  glideToTarget,
  lerp,
  lerpAngle,
  renderPosition,
  wrapAngle,
} from "./interpolation.js";
import type { Tracked } from "./interpolation.js";
import { randomFreePosition } from "./map.js";
import type { Player } from "./player.js";
import { createPlayer } from "./player.js";
import type { Session } from "./session.js";
import { heardAt, reportedAt } from "../integration/heard.js";
import { createSession, updateSession } from "./session.js";

const FIXED_DT = 1 / 60;
const PLAYER_RADIUS = testSimConfig.player.radius;

const walkRight = {
  move: { x: 1, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

function session(): Session {
  return createSession(
    "me",
    "ME",
    "LERP1",
    "standard",
    testSfx(),
    testSimConfig,
  );
}

test("lerp blends between two values", () => {
  expect(lerp(100, 110, 0)).toBe(100);
  expect(lerp(100, 110, 0.5)).toBe(105);
  expect(lerp(100, 110, 1)).toBe(110);
});

test("render position blends from the previous position", () => {
  const body = { x: 110, y: 50, prevX: 100, prevY: 40 };
  expect(renderPosition(body, 0.5)).toEqual({ x: 105, y: 45 });
  expect(renderPosition(body, 1)).toEqual({ x: 110, y: 50 });
});

test("a spawned player starts with no previous motion", () => {
  const player = createPlayer("p", "P", { x: 100, y: 100 }, testSimConfig);
  expect({ x: player.prevX, y: player.prevY }).toEqual({
    x: player.x,
    y: player.y,
  });
});

test("after a step the local player's previous position is its pre-step position", () => {
  const game = session();
  const start = randomFreePosition(game.world, PLAYER_RADIUS);
  game.local.x = start.x;
  game.local.y = start.y;

  updateSession(game, walkRight, FIXED_DT);

  expect({ x: game.local.prevX, y: game.local.prevY }).toEqual(start);
});

test("a remote player first seen in a host snapshot snaps there, then interpolates", () => {
  const game = session();
  game.hosting = false;
  const first = randomFreePosition(game.world, PLAYER_RADIUS);
  const remote = heardAt(game, "them", first);
  expect(remote).toMatchObject({ ...first, prevX: first.x, prevY: first.y });

  // Near enough to have walked there between snapshots; further off, it would be placed there.
  heardAt(game, "them", { x: first.x + 5, y: first.y });
  updateSession(game, walkRight, FIXED_DT);

  expect({ x: remote.prevX, y: remote.prevY }).toEqual(first);
  expect(remote.x).not.toBe(first.x);
});

const degrees = (value: number): number => (value * Math.PI) / 180;

test("angles wrap into -π..π", () => {
  expect(wrapAngle(degrees(190))).toBeCloseTo(degrees(-170));
  expect(wrapAngle(degrees(-190))).toBeCloseTo(degrees(170));
  expect(wrapAngle(degrees(45))).toBeCloseTo(degrees(45));
});

test("lerpAngle takes the shortest arc across the ±π wrap", () => {
  const halfway = lerpAngle(degrees(170), degrees(-170), 0.5);
  expect(Math.abs(halfway)).toBeCloseTo(Math.PI);
  expect(lerpAngle(degrees(170), degrees(-170), 0.25)).toBeCloseTo(
    degrees(175),
  );
  expect(lerpAngle(degrees(-170), degrees(170), 0.25)).toBeCloseTo(
    degrees(-175),
  );
  expect(lerpAngle(degrees(10), degrees(30), 0.5)).toBeCloseTo(degrees(20));
});

function remoteAt(game: Session, aim: number): Player {
  return reportedAt(
    game,
    "them",
    randomFreePosition(game.world, PLAYER_RADIUS),
    aim,
  );
}

test("a remote player first heard snaps its aim and previous aim to the one it reports", () => {
  const remote = remoteAt(session(), degrees(120));
  expect(remote.aim).toBeCloseTo(degrees(120));
  expect(remote.prevAim).toBeCloseTo(degrees(120));
  expect(remote.taim).toBeCloseTo(degrees(120));
});

test("remote aim eases towards the network target across the wrap, storing the previous aim each step", () => {
  const game = session();
  const remote = remoteAt(game, degrees(170));
  reportedAt(game, "them", remote, degrees(-170));

  updateSession(game, walkRight, FIXED_DT);
  const afterOne = remote.aim;
  expect(remote.prevAim).toBeCloseTo(degrees(170));
  expect(Math.abs(afterOne)).toBeGreaterThan(degrees(170));

  updateSession(game, walkRight, FIXED_DT);
  expect(remote.prevAim).toBe(afterOne);

  for (let step = 0; step < 120; step++) {
    updateSession(game, walkRight, FIXED_DT);
  }
  expect(remote.aim).toBeCloseTo(degrees(-170));
});

describe("a body following reports at a steady rate", () => {
  /**
   * Per-step distances of a body moving 3px right every 6 steps, reported as it goes, 10 times a
   * second at 60 steps a second; the report due at `late` arrives 2 steps after.
   */
  function steps(late = -1): number[] {
    const body: Tracked = { x: 0, y: 0, tx: 0, ty: 0 };
    const moved: number[] = [];
    for (let step = 0; step < 60; step++) {
      const due = step === late + 2 ? late : step === late ? -1 : step;
      if (due >= 0 && due % 6 === 0)
        glideTo(body, { x: (due / 6 + 1) * 3, y: 0 }, testSimConfig.net.glide);
      const from = body.x;
      glideToTarget(body, FIXED_DT);
      moved.push(body.x - from);
    }
    return moved;
  }

  test("moves the same distance every step, once under way", () => {
    for (const moved of steps().slice(30)) expect(moved).toBeCloseTo(0.5, 2);
  });

  test("keeps moving through a late report, not stopping for it", () => {
    for (const moved of steps(30).slice(6)) {
      expect(moved).toBeGreaterThan(0.25);
      expect(moved).toBeLessThan(0.75);
    }
  });

  test("arrives where it was last reported, and a repeated report changes nothing", () => {
    const body: Tracked = { x: 0, y: 0, tx: 0, ty: 0 };
    glideTo(body, { x: 3, y: 4 }, 0.1);
    for (let step = 0; step < 3; step++) glideToTarget(body, FIXED_DT);
    const glide = body.glide;
    glideTo(body, { x: 3, y: 4 }, 0.1);
    expect(body.glide).toBe(glide);
    for (let step = 0; step < 10; step++) glideToTarget(body, FIXED_DT);
    expect(body).toMatchObject({ x: 3, y: 4, glide: 0 });
  });
});
