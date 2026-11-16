import { expect, test } from "vitest";
import { nextInList, placeInList } from "./playlist.js";

test("a list is placed by the time since it started, across its sounds and round again when it loops", () => {
  const lengths = [10, 20, 5];
  expect(placeInList(lengths, 0, true)).toEqual({ index: 0, offset: 0 });
  expect(placeInList(lengths, 12, true)).toEqual({ index: 1, offset: 2 });
  expect(placeInList(lengths, 33, true)).toEqual({ index: 2, offset: 3 });
  expect(placeInList(lengths, 35 * 4 + 31, true)).toEqual({
    index: 2,
    offset: 1,
  });
  expect(placeInList(lengths, 36, false)).toBeNull();
  expect(placeInList(lengths, 34, false)).toEqual({ index: 2, offset: 4 });
});

test("a sound of no length, one that would not load, is passed over; a list of nothing plays nothing", () => {
  expect(placeInList([0, 10], 3, true)).toEqual({ index: 1, offset: 3 });
  expect(placeInList([0, 0], 3, true)).toBeNull();
  expect(nextInList([10, 0, 5], 0, true)).toEqual({ index: 2, offset: 0 });
  expect(nextInList([10, 0, 5], 2, true)).toEqual({ index: 0, offset: 0 });
  expect(nextInList([10, 5], 1, false)).toBeNull();
  expect(nextInList([7], 0, true)).toEqual({ index: 0, offset: 0 });
});
