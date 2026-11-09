import { expect, test } from "vitest";
import { mapWithCenterWall } from "../integration/tile-maps.js";
import { createMap, isAreaFree, mulberry32 } from "./map.js";

test("map generation is reproducible from a seed", () => {
  const first = createMap(40, 30, 50, mulberry32(123));
  const second = createMap(40, 30, 50, mulberry32(123));
  expect(first.solid).toEqual(second.solid);
});

test("map occupancy rejects walls and world boundaries", () => {
  const map = mapWithCenterWall();
  expect(isAreaFree(map, 75, 75, 14)).toBe(true);
  expect(isAreaFree(map, 125, 125, 14)).toBe(false);
  expect(isAreaFree(map, 0, 75, 14)).toBe(false);
});
