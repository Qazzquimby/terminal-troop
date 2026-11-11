import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { lerp, lerpAngle, renderPosition, wrapAngle } from "./interpolation.js";
import { randomFreePosition } from "./map.js";
import type { Player } from "./player.js";
import { createPlayer } from "./player.js";
import type { Session } from "./session.js";
import { createSession, applyRemoteState, updateSession } from "./session.js";

const FIXED_DT = 1 / 60;
const PLAYER_RADIUS = testSimConfig.player.radius;

const walkRight = {
  move: { x: 1, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  select: null,
  use: false,
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
  const player = createPlayer("p", "P", session().world, testSimConfig);
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

test("a remote player first seen in a state snaps there, then interpolates", () => {
  const game = session();
  const first = randomFreePosition(game.world, PLAYER_RADIUS);
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    ...first,
    aim: 0,
    health: 100,
    held: null,
  });

  const remote = game.players.get("them");
  if (remote === undefined) throw new Error("remote player was not created");
  expect(remote).toMatchObject({ ...first, prevX: first.x, prevY: first.y });

  const next = randomFreePosition(game.world, PLAYER_RADIUS);
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    ...next,
    aim: 0,
    health: 100,
    held: null,
  });
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
  const position = randomFreePosition(game.world, PLAYER_RADIUS);
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    ...position,
    aim,
    health: 100,
    held: null,
  });
  const remote = game.players.get("them");
  if (remote === undefined) throw new Error("remote player was not created");
  return remote;
}

test("a remote player first seen snaps its aim and previous aim to the state", () => {
  const remote = remoteAt(session(), degrees(120));
  expect(remote.aim).toBeCloseTo(degrees(120));
  expect(remote.prevAim).toBeCloseTo(degrees(120));
  expect(remote.taim).toBeCloseTo(degrees(120));
});

test("remote aim eases towards the network target across the wrap, storing the previous aim each step", () => {
  const game = session();
  const remote = remoteAt(game, degrees(170));
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    x: remote.tx,
    y: remote.ty,
    aim: degrees(-170),
    health: 100,
    held: null,
  });

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
