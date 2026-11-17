import { expect, test } from "vitest";
import { salePrice } from "../../sim/index.js";
import { drawSales } from "./finances.js";

const SALES = { chance: 0.15, minOff: 25, maxOff: 75, every: 120 };
const WARES = [
  { item: "walkie", price: 2 },
  { item: "bomb", price: 6 },
  { item: "turret", price: 8 },
];

/** Draws `values` in turn, as an rng would. */
const drawing = (...values: number[]) => {
  let at = 0;
  return () => values[at++] ?? 0.99;
};

test("each ware goes on sale under its chance, 25 to 75% off in steps of 5", () => {
  // walkie: on sale, the lowest step; bomb: off; turret: on sale, the top step.
  expect(drawSales(WARES, SALES, drawing(0.1, 0, 0.5, 0.14, 0.999))).toEqual({
    walkie: 25,
    turret: 75,
  });
  expect(drawSales(WARES, SALES, () => 0.15)).toEqual({});
});

test("over many draws about 15% of wares are on sale, and never outside 25..75% off", () => {
  let on = 0;
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let draw = 0; draw < 2000; draw++) {
    const off = Object.values(drawSales(WARES, SALES, rng));
    on += off.length;
    for (const each of off) {
      expect(each).toBeGreaterThanOrEqual(25);
      expect(each).toBeLessThanOrEqual(75);
      expect(each % 5).toBe(0);
    }
  }
  expect(on / (2000 * WARES.length)).toBeCloseTo(0.15, 1);
});

test("a sale price is whole credit, rounded down, never under 1", () => {
  expect(salePrice(8, 0)).toBe(8);
  expect(salePrice(8, 25)).toBe(6);
  expect(salePrice(8, 75)).toBe(2);
  expect(salePrice(3, 50)).toBe(1);
  expect(salePrice(2, 75)).toBe(1);
});
