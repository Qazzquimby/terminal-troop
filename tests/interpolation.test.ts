import { expect, test } from "vitest";
import { createSfx } from "../src/engine/audio.js";
import { FIXED_DT, PLAYER_RADIUS } from "../src/engine/config.js";
import { registerEntityType, spawnEntity } from "../src/engine/entities.js";
import {
  lerp,
  lerpAngle,
  renderPosition,
  stepAlpha,
  wrapAngle,
} from "../src/engine/interpolation.js";
import { randomFreePosition } from "../src/engine/map.js";
import type { Player } from "../src/engine/player.js";
import { createPlayer } from "../src/engine/player.js";
import { interpolatedView } from "../src/engine/render.js";
import type { Session } from "../src/engine/session.js";
import {
  createSession,
  receiveState,
  updateSession,
} from "../src/engine/session.js";

const walkRight = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };
const origin = { x: 0, y: 0 };

function session(): Session {
  return createSession("me", "ME", "LERP1", "standard", createSfx());
}

test("lerp blends between two values", () => {
  expect(lerp(100, 110, 0)).toBe(100);
  expect(lerp(100, 110, 0.5)).toBe(105);
  expect(lerp(100, 110, 1)).toBe(110);
});

test("alpha is the leftover fraction of a step, clamped to 0..1", () => {
  expect(stepAlpha(0, FIXED_DT)).toBe(0);
  expect(stepAlpha(FIXED_DT / 2, FIXED_DT)).toBeCloseTo(0.5);
  expect(stepAlpha(FIXED_DT * 2, FIXED_DT)).toBe(1);
  expect(stepAlpha(-1, FIXED_DT)).toBe(0);
});

test("render position blends from the previous position", () => {
  const body = { x: 110, y: 50, prevX: 100, prevY: 40 };
  expect(renderPosition(body, 0.5)).toEqual({ x: 105, y: 45 });
  expect(renderPosition(body, 1)).toEqual({ x: 110, y: 50 });
});

test("a spawned player starts with no previous motion", () => {
  const player = createPlayer("p", "P", session().world);
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

  updateSession(game, walkRight, FIXED_DT, performance.now());

  expect({ x: game.local.prevX, y: game.local.prevY }).toEqual(start);
});

test("a remote player first seen in a state snaps there, then interpolates", () => {
  const game = session();
  const first = randomFreePosition(game.world, PLAYER_RADIUS);
  receiveState(game, { id: "them", name: "THEM", ...first, aim: 0 });

  const remote = game.players.get("them");
  if (remote === undefined) throw new Error("remote player was not created");
  expect(remote).toMatchObject({ ...first, prevX: first.x, prevY: first.y });

  const next = randomFreePosition(game.world, PLAYER_RADIUS);
  receiveState(game, { id: "them", name: "THEM", ...next, aim: 0 });
  updateSession(game, walkRight, FIXED_DT, performance.now());

  expect({ x: remote.prevX, y: remote.prevY }).toEqual(first);
  expect(remote.x).not.toBe(first.x);
});

test("entities record their pre-step position", () => {
  const game = session();
  registerEntityType(game, 1, {
    radius: 5,
    collides: false,
    draw: () => undefined,
  });
  const entity = spawnEntity(game, 1, 100, 200);
  expect(entity).toMatchObject({ prevX: 100, prevY: 200 });

  entity.vx = 10 / FIXED_DT;
  updateSession(game, walkRight, FIXED_DT, performance.now());

  expect(entity).toMatchObject({ x: 110, prevX: 100 });
  expect(interpolatedView(game, 0.5, origin).entities.get(entity.id)?.x).toBe(
    105,
  );
});

test("the render view draws bodies between steps without touching the simulation", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world);
  game.players.set("them", remote);
  Object.assign(remote, { prevX: 100, x: 110, prevY: 50, y: 50 });
  Object.assign(game.local, { prevX: 300, x: 320 });

  const view = interpolatedView(game, 0.5, origin);

  expect(view.players.get("them")).toMatchObject({ x: 105, y: 50 });
  expect(view.local.x).toBe(310);
  expect(view.players.get("me")).toBe(view.local);
  expect(view.local.stamina).toBe(game.local.stamina);
  expect(remote.x).toBe(110);
  expect(game.local.x).toBe(320);

  const settled = interpolatedView(game, 1, origin);
  expect(settled.players.get("them")).toMatchObject({ x: 110, y: 50 });
  expect(settled.local.x).toBe(320);
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
  receiveState(game, { id: "them", name: "THEM", ...position, aim });
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
  receiveState(game, {
    id: "them",
    name: "THEM",
    x: remote.tx,
    y: remote.ty,
    aim: degrees(-170),
  });

  updateSession(game, walkRight, FIXED_DT, performance.now());
  const afterOne = remote.aim;
  expect(remote.prevAim).toBeCloseTo(degrees(170));
  expect(Math.abs(afterOne)).toBeGreaterThan(degrees(170));

  updateSession(game, walkRight, FIXED_DT, performance.now());
  expect(remote.prevAim).toBe(afterOne);

  for (let step = 0; step < 120; step++) {
    updateSession(game, walkRight, FIXED_DT, performance.now());
  }
  expect(remote.aim).toBeCloseTo(degrees(-170));
});

test("the view's remote aim is interpolated by alpha along the shortest arc", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world);
  game.players.set("them", remote);
  Object.assign(remote, { prevAim: degrees(160), aim: degrees(-160) });

  const quarter = interpolatedView(game, 0.25, origin).players.get("them");
  const start = interpolatedView(game, 0, origin).players.get("them");

  expect(quarter?.aim).toBeCloseTo(degrees(170));
  expect(start?.aim).toBeCloseTo(degrees(160));
  expect(remote.aim).toBeCloseTo(degrees(-160));
});

test("the view's local aim points from the interpolated position to the mouse", () => {
  const game = session();
  Object.assign(game.local, { prevX: 300, x: 320, prevY: 200, y: 200, aim: 2 });

  const view = interpolatedView(game, 0.5, { x: 310, y: 250 });

  expect(view.local.aim).toBeCloseTo(Math.PI / 2);
  expect(view.players.get("me")?.aim).toBeCloseTo(Math.PI / 2);
  expect(game.local.aim).toBe(2);
});
