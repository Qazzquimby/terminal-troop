import { expect, test } from "vitest";
import { aimAhead, turnMove } from "./turn.js";

/** Turns a screen direction a quarter turn clockwise: up the screen is the world's right. */
const quarter = (d: { x: number; y: number }) => ({ x: -d.y, y: d.x });

test("the aim of a turned view lies straight ahead of the body", () => {
  const aim = aimAhead({ x: 10, y: 20 }, Math.PI / 2);
  expect(aim.x).toBeCloseTo(10);
  expect(aim.y).toBeGreaterThan(20);
});

test("keys steer as the turned screen shows the world, their strength kept", () => {
  const ahead = turnMove({ x: 0, y: -1 }, quarter, 64);
  expect(ahead.x).toBeCloseTo(1);
  expect(ahead.y).toBeCloseTo(0);
  const diagonal = turnMove({ x: Math.SQRT1_2, y: -Math.SQRT1_2 }, quarter, 64);
  expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
});

test("a turned steer keeps to one of the given ways round, so a slow turn changes it rarely", () => {
  const turnedBy = (angle: number) => (d: { x: number; y: number }) => ({
    x: d.x * Math.cos(angle) - d.y * Math.sin(angle),
    y: d.x * Math.sin(angle) + d.y * Math.cos(angle),
  });
  const up = { x: 0, y: -1 };
  expect(turnMove(up, turnedBy(0.01), 8)).toEqual(
    turnMove(up, turnedBy(0.2), 8),
  );
  expect(turnMove(up, turnedBy(0.01), 8)).not.toEqual(
    turnMove(up, turnedBy(0.6), 8),
  );
});

test("no steer stays none", () => {
  expect(turnMove({ x: 0, y: 0 }, quarter, 64)).toEqual({ x: 0, y: 0 });
});
