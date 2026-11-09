import { expect, test } from "vitest";
import { mapWithCenterWall } from "../integration/tile-maps.js";
import { moveWithCollision } from "./collision.js";
import { isAreaFree } from "./map.js";

test("wall movement stops at the collision face", () => {
  const map = mapWithCenterWall();
  const body = { x: 85, y: 125, vx: 220, vy: 0 };

  moveWithCollision(body, 14, 1 / 60, map);

  expect(body.x).toBe(86);
  expect(Math.abs(body.vx)).toBe(0);
  expect(isAreaFree(map, body.x, body.y, 14)).toBe(true);
});
