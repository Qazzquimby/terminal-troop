import { expect, test } from "vitest";
import { cycleTarget } from "./cabin-minimap.js";

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
