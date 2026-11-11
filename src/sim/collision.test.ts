import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { emptyMap, mapWithCenterWall } from "../integration/tile-maps.js";
import { moveWithCollision, separateBodies } from "./collision.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { isAreaFree } from "./map.js";
import { applyRemoteState, createSession, updateSession } from "./session.js";

test("wall movement stops at the collision face", () => {
  const map = mapWithCenterWall();
  const body = { x: 85, y: 125, vx: 220, vy: 0 };

  moveWithCollision(body, 14, 1 / 60, map, 0);

  expect(body.x).toBe(86);
  expect(Math.abs(body.vx)).toBe(0);
  expect(isAreaFree(map, body.x, body.y, 14)).toBe(true);
});

test("overlapping bodies separate and lose inward velocity", () => {
  const first = { x: 75, y: 75, vx: 10, vy: 5, radius: 10 };
  const second = { x: 90, y: 75, vx: -10, vy: 5, radius: 10 };

  separateBodies([first, second], emptyMap());

  expect(second.x - first.x).toBeGreaterThanOrEqual(20 - 1e-5);
  expect(first.vx).toBeCloseTo(0);
  expect(second.vx).toBeCloseTo(0);
  expect(first.vy).toBe(5);
  expect(second.vy).toBe(5);
});

test("body separation uses circles rather than bounding boxes", () => {
  const first = { x: 75, y: 75, vx: 0, vy: 0, radius: 10 };
  const second = { x: 90, y: 90, vx: 0, vy: 0, radius: 10 };

  separateBodies([first, second], emptyMap());

  expect(first).toMatchObject({ x: 75, y: 75 });
  expect(second).toMatchObject({ x: 90, y: 90 });
});

test("coincident bodies separate without invalid coordinates", () => {
  const first = { x: 75, y: 75, vx: 0, vy: 0, radius: 10 };
  const second = { ...first };

  separateBodies([first, second], emptyMap());

  expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeCloseTo(20, 5);
});

test("a coincident movable body can separate away from a map boundary", () => {
  const first = { x: 10, y: 75, vx: 0, vy: 0, radius: 10 };
  const second = { ...first };

  separateBodies([first, second], emptyMap(), new Set([first]));

  expect(first.x).toBeGreaterThanOrEqual(30 - 1e-5);
  expect(second.x).toBe(10);
});

test("a wall-blocked separation transfers to the other body", () => {
  const map = mapWithCenterWall();
  const first = { x: 86, y: 125, vx: 0, vy: 0, radius: 14 };
  const second = { x: 66, y: 125, vx: 0, vy: 0, radius: 14 };

  separateBodies([first, second], map);

  expect(first.x).toBe(86);
  expect(second.x).toBeCloseTo(58, 5);
  for (const body of [first, second]) {
    expect(isAreaFree(map, body.x, body.y, body.radius)).toBe(true);
  }
});

test("separation resolves a chain of overlapping bodies", () => {
  const bodies = [60, 68, 76].map((x) => ({
    x,
    y: 75,
    vx: 0,
    vy: 0,
    radius: 10,
  }));

  separateBodies(bodies, emptyMap());

  for (const [index, first] of bodies.entries()) {
    for (const second of bodies.slice(index + 1)) {
      expect(
        Math.hypot(first.x - second.x, first.y - second.y),
      ).toBeGreaterThanOrEqual(first.radius + second.radius - 1e-5);
    }
  }
});

const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 500, y: 300 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
};

function collisionSession() {
  const game = createSession(
    "me",
    "ME",
    "COLLISION",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 400, y: 300 });
  const definition = {
    radius: 14,
    maxHealth: 10,
    data: z.null(),
    draw: () => undefined,
  };
  registerEntityType(game, "solid", definition);
  registerEntityType(game, "ghost", { ...definition, collides: false });
  return game;
}

test("a session separates its player and entities and updates host targets", () => {
  const game = collisionSession();
  const entity = spawnEntity(game, "solid", game.local.x, game.local.y, null);

  updateSession(game, idle, 1 / 60);

  expect(
    Math.hypot(entity.x - game.local.x, entity.y - game.local.y),
  ).toBeGreaterThanOrEqual(entity.radius + game.local.radius - 1e-5);
  expect(entity.tx).toBe(entity.x);
  expect(entity.ty).toBe(entity.y);
});

test("a session separates entities from other entities", () => {
  const game = collisionSession();
  const first = spawnEntity(game, "solid", 500, 300, null);
  const second = spawnEntity(game, "solid", 500, 300, null);

  updateSession(game, idle, 1 / 60);

  expect(
    Math.hypot(first.x - second.x, first.y - second.y),
  ).toBeGreaterThanOrEqual(first.radius + second.radius - 1e-5);
});

test("noncolliding entities do not separate from players", () => {
  const game = collisionSession();
  const entity = spawnEntity(game, "ghost", game.local.x, game.local.y, null);

  updateSession(game, idle, 1 / 60);

  expect(game.local).toMatchObject({ x: 400, y: 300 });
  expect(entity).toMatchObject({ x: 400, y: 300 });
});

test("player separation does not move remote players", () => {
  const game = collisionSession();
  applyRemoteState(game, {
    id: "peer",
    name: "PEER",
    x: 400,
    y: 300,
    aim: 0,
    health: 100,
    content: {},
  });

  updateSession(game, idle, 1 / 60);

  expect(game.players.get("peer")).toMatchObject({ x: 400, y: 300 });
  expect(
    Math.hypot(game.local.x - 400, game.local.y - 300),
  ).toBeGreaterThanOrEqual(game.local.radius * 2 - 1e-5);
});

test("a client yields to entities without changing their host targets", () => {
  const game = collisionSession();
  game.hosting = false;
  const entity = spawnEntity(game, "solid", game.local.x, game.local.y, null);

  updateSession(game, idle, 1 / 60);

  expect(entity).toMatchObject({ x: 400, y: 300, tx: 400, ty: 300 });
  expect(
    Math.hypot(entity.x - game.local.x, entity.y - game.local.y),
  ).toBeGreaterThanOrEqual(entity.radius + game.local.radius - 1e-5);
});
