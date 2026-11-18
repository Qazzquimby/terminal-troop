import { expect, test } from "vitest";
import { testSimConfig } from "../integration/sim-config.js";
import { createPlayer } from "../sim/index.js";
import { viewHeading } from "./turning.js";

const player = (aim: number) => ({
  ...createPlayer("p", "P", { x: 0, y: 0 }, testSimConfig),
  aim,
});
const riding = (heading: number) => ({
  ...player(0),
  ride: { vehicle: "car", driving: true, heading, speed: 0, turn: 0 },
});

test("on foot, the mouse turns the view from where it faced", () => {
  expect(viewHeading(1, { kind: "self" }, player(0), 0.25)).toBe(1.25);
});

test("in a vehicle the view points along its heading, whatever the mouse does", () => {
  expect(viewHeading(1, { kind: "self" }, riding(2), 0.25)).toBe(2);
});

test("a ghost watching a player looks the way that player looks, or its vehicle points", () => {
  const local = player(0);
  expect(
    viewHeading(1, { kind: "watch", player: player(-2) }, local, 0.5),
  ).toBe(-2);
  expect(viewHeading(1, { kind: "watch", player: riding(3) }, local, 0.5)).toBe(
    3,
  );
});

test("a ghost's free camera turns with the mouse", () => {
  const free = { kind: "free", at: { x: 0, y: 0 } } as const;
  expect(viewHeading(1, free, player(0), -0.5)).toBe(0.5);
});
