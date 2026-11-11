import { expect, test } from "vitest";
import type { Entity } from "./entity.js";
import { knockBack } from "./knockback.js";
import type { TileMap } from "./map.js";

/** Open floor 500px square; outside it is solid. */
const map: TileMap = {
  cell: 50,
  cols: 10,
  rows: 10,
  solid: new Uint8Array(100),
};

const body = (x: number, y: number): Entity => ({
  x,
  y,
  vx: 0,
  vy: 0,
  radius: 15,
  health: 10,
  maxHealth: 10,
});

test.each(["stop", "stay"] as const)(
  "pushes straight away from the source, the full distance on open floor (%s)",
  (blocked) => {
    const entity = body(200, 200);
    knockBack(entity, { x: 170, y: 160 }, 50, map, blocked);
    expect(entity.x).toBeCloseTo(230);
    expect(entity.y).toBeCloseTo(240);
  },
);

test.each(["stop", "stay"] as const)(
  "leaves an entity standing on the source where it is (%s)",
  (blocked) => {
    const entity = body(200, 200);
    knockBack(entity, { x: 200, y: 200 }, 50, map, blocked);
    expect(entity).toMatchObject({ x: 200, y: 200 });
  },
);

test("stop: a wall in the way stops the entity short against it", () => {
  const entity = body(400, 250);
  knockBack(entity, { x: 350, y: 250 }, 90, map, "stop");
  expect(entity.x).toBeGreaterThan(480);
  expect(entity.x).toBeLessThanOrEqual(485);
  expect(entity.y).toBe(250);
});

test("stay: a wall where the push ends leaves the entity where it was", () => {
  const entity = body(400, 250);
  knockBack(entity, { x: 350, y: 250 }, 90, map, "stay");
  expect(entity).toMatchObject({ x: 400, y: 250 });
});

test("stop: never carries the entity through a wall to open floor beyond", () => {
  const walled = new Uint8Array(100);
  for (let row = 0; row < 10; row++) walled[row * 10 + 5] = 1;
  const wall: TileMap = { ...map, solid: walled };
  const entity = body(220, 250);
  knockBack(entity, { x: 200, y: 250 }, 120, wall, "stop");
  expect(entity.x).toBeLessThanOrEqual(235);
});
