import { expect, test } from "vitest";
import { cycleTarget, sweepAngle, teleportButton } from "./cabin-minimap.js";

test("the radar sweep starts straight up and goes round clockwise once a period", () => {
  expect(sweepAngle(0, 2000)).toBeCloseTo(-Math.PI / 2);
  expect(sweepAngle(500, 2000)).toBeCloseTo(0);
  expect(sweepAngle(1000, 2000)).toBeCloseTo(Math.PI / 2);
  expect(sweepAngle(2500, 2000)).toBeCloseTo(sweepAngle(500, 2000));
});

const TARGETS = ["ann", "bob", "cat"];

test("the minimap steps through who it follows, wrapping round both ends", () => {
  expect(cycleTarget(TARGETS, "ann", 1)).toBe("bob");
  expect(cycleTarget(TARGETS, "cat", 1)).toBe("ann");
  expect(cycleTarget(TARGETS, "ann", -1)).toBe("cat");
  expect(cycleTarget(TARGETS, "bob", 0)).toBe("bob");
});

test("with no one followed yet, or one no longer alive, it follows the first", () => {
  expect(cycleTarget(TARGETS, null, 0)).toBe("ann");
  expect(cycleTarget(TARGETS, "dan", 1)).toBe("ann");
  expect(cycleTarget([], "ann", 1)).toBeNull();
});

const outside = { id: "ann", ride: null };
const aboard = {
  id: "bob",
  ride: { vehicle: "1", driving: false, heading: 0, speed: 0, turn: 0 },
};

test("the teleport button shows only for a vehicle with a teleporter", () => {
  expect(teleportButton(null, outside).shown).toBe(false);
  expect(teleportButton({ sending: null }, outside)).toMatchObject({
    shown: true,
    enabled: true,
    charging: false,
  });
});

test("it sends for one player out in the world at a time, and shows who it is bringing", () => {
  expect(teleportButton({ sending: null }, aboard).enabled).toBe(false);
  expect(teleportButton({ sending: null }, undefined).enabled).toBe(false);
  expect(teleportButton({ sending: "bob" }, outside).enabled).toBe(false);
  expect(teleportButton({ sending: "ann" }, outside)).toMatchObject({
    enabled: false,
    charging: true,
  });
});
