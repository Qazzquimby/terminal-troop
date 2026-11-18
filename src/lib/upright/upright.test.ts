import { expect, test } from "vitest";
import { onScreenAngle, upright, withRoll } from "./upright.js";

/** A context that logs the turns and moves made of it. */
function loggingContext() {
  const log: string[] = [];
  return {
    log,
    save: () => log.push("save"),
    restore: () => log.push("restore"),
    translate: (x: number, y: number) =>
      log.push(`translate ${String(x)} ${String(y)}`),
    rotate: (angle: number) => log.push(`rotate ${angle.toFixed(2)}`),
  };
}

test("an unturned context draws upright as it is, with nothing turned", () => {
  const ctx = loggingContext();
  upright(ctx, { x: 5, y: 6 }, () => ctx.log.push("draw"));
  expect(ctx.log).toEqual(["draw"]);
});

test("under a turned camera, a drawing is turned back about its point, once however nested", () => {
  const ctx = loggingContext();
  withRoll(ctx, 0.5, () => {
    upright(ctx, { x: 5, y: 6 }, () => {
      upright(ctx, { x: 1, y: 1 }, () => ctx.log.push("draw"));
    });
  });
  expect(ctx.log).toEqual([
    "save",
    "translate 5 6",
    "rotate -0.50",
    "translate -5 -6",
    "draw",
    "restore",
  ]);
});

test("a world direction is turned on the screen as the camera turns it, only while it does", () => {
  const ctx = loggingContext();
  withRoll(ctx, 1, () => {
    expect(onScreenAngle(ctx, 0.25)).toBeCloseTo(1.25);
  });
  expect(onScreenAngle(ctx, 0.25)).toBe(0.25);
});
