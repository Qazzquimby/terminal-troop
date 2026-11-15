import { expect, test } from "vitest";
import { pushShare } from "./mass.js";

test("a body no heavier than its pusher takes the whole push, and goes no farther", () => {
  expect(pushShare(1, 1)).toBe(1);
  expect(pushShare(1, 0.25)).toBe(1);
});

test("a body heavier than its pusher takes less of the push, in proportion", () => {
  expect(pushShare(1, 2)).toBe(0.5);
  expect(pushShare(2, 8)).toBe(0.25);
});

test("an immovable body takes none of a push, however heavy the pusher", () => {
  expect(pushShare(1, Infinity)).toBe(0);
  expect(pushShare(Infinity, Infinity)).toBe(0);
});

test("an immovable pusher, such as a ramming cruiser, moves any body it can move in full", () => {
  expect(pushShare(Infinity, 50)).toBe(1);
});
