import { expect, test } from "vitest";
import { z } from "zod";
import { rounded } from "./rounded.js";

test.each([
  [1, 6383.650081222386, 6383.7],
  [1, -0.04, -0],
  [2, -2.827866375587991, -2.83],
  [2, 3, 3],
])("to %d places, %d travels as %d", (decimals, value, wire) => {
  const schema = rounded(decimals);
  expect(schema.encode(value)).toBe(wire);
  expect(schema.decode(wire)).toBe(wire);
});

test("a value round-trips through JSON within half a step", () => {
  const schema = rounded(1);
  for (let value = -50; value < 50; value += 0.37) {
    const wire: unknown = JSON.parse(JSON.stringify(schema.encode(value)));
    expect(Math.abs(schema.parse(wire) - value)).toBeLessThanOrEqual(0.05);
  }
});

test("a whole number travels exactly, so a body against a wall stays clear of it", () => {
  const schema = rounded(1);
  for (const face of [36, 1214, 7986]) {
    expect(schema.encode(face)).toBe(face);
    expect(schema.encode(face - 1e-9)).toBeLessThanOrEqual(face);
    expect(schema.encode(face - 0.04)).toBeLessThanOrEqual(face);
  }
});

test("the schema it is given checks both ways", () => {
  const schema = rounded(2, z.number().min(0));
  expect(schema.safeParse(-1).success).toBe(false);
  expect(() => schema.encode(-1)).toThrow();
  expect(schema.encode(0.001)).toBe(0);
});
