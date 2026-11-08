import { expect, test } from "vitest";
import { createSfx } from "../src/engine/audio.js";
import { FIXED_DT, PLAYER_RADIUS } from "../src/engine/config.js";
import { registerEntityType, spawnEntity } from "../src/engine/entities.js";
import {
  lerp,
  renderPosition,
  stepAlpha,
} from "../src/engine/interpolation.js";
import { randomFreePosition } from "../src/engine/map.js";
import { createPlayer } from "../src/engine/player.js";
import { interpolatedView } from "../src/engine/render.js";
import type { Session } from "../src/engine/session.js";
import {
  createSession,
  receiveState,
  updateSession,
} from "../src/engine/session.js";

const walkRight = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };

function session(): Session {
  return createSession("me", "ME", "LERP1", createSfx());
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
  expect(interpolatedView(game, 0.5).entities.get(entity.id)?.x).toBe(105);
});

test("the render view draws bodies between steps without touching the simulation", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world);
  game.players.set("them", remote);
  Object.assign(remote, { prevX: 100, x: 110, prevY: 50, y: 50 });
  Object.assign(game.local, { prevX: 300, x: 320, aim: 1 });

  const view = interpolatedView(game, 0.5);

  expect(view.players.get("them")).toMatchObject({ x: 105, y: 50 });
  expect(view.local).toMatchObject({ x: 310, aim: 1 });
  expect(view.players.get("me")).toBe(view.local);
  expect(view.local.stamina).toBe(game.local.stamina);
  expect(remote.x).toBe(110);
  expect(game.local.x).toBe(320);

  const settled = interpolatedView(game, 1);
  expect(settled.players.get("them")).toMatchObject({ x: 110, y: 50 });
  expect(settled.local.x).toBe(320);
});
