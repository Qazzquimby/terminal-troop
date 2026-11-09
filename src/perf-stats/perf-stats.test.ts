import { expect, test } from "vitest";
import { createPerfStats } from "./perf-stats.js";

function frame(now: number, steps = 1, updateMs = 0, drawMs = 0) {
  return { now, steps, updateMs, drawMs };
}

test("an empty collector reports zeros", () => {
  expect(createPerfStats().snapshot(0)).toEqual({
    fps: 0,
    frameMsAvg: 0,
    frameMsMax: 0,
    stepsAvg: 0,
    zeroStepShare: 0,
    multiStepShare: 0,
    updateMsAvg: 0,
    drawMsAvg: 0,
  });
});

test("steady 60Hz frames read as 60 fps", () => {
  const stats = createPerfStats();
  const period = 1000 / 60;
  for (let i = 0; i <= 60; i++) stats.recordFrame(frame(i * period));

  const snapshot = stats.snapshot(60 * period);
  expect(snapshot.fps).toBeCloseTo(60);
  expect(snapshot.frameMsAvg).toBeCloseTo(period);
  expect(snapshot.frameMsMax).toBeCloseTo(period);
  expect(snapshot.stepsAvg).toBe(1);
});

test("averages frame, update and draw time and tracks the worst frame", () => {
  const stats = createPerfStats();
  stats.recordFrame(frame(0, 1, 1, 2));
  stats.recordFrame(frame(10, 1, 3, 4));
  stats.recordFrame(frame(40, 1, 5, 6));

  const snapshot = stats.snapshot(40);
  expect(snapshot.frameMsAvg).toBe(20);
  expect(snapshot.frameMsMax).toBe(30);
  expect(snapshot.fps).toBe(50);
  expect(snapshot.updateMsAvg).toBe(3);
  expect(snapshot.drawMsAvg).toBe(4);
});

test("reports the step distribution", () => {
  const stats = createPerfStats();
  [0, 1, 1, 2, 3, 1, 0, 0].forEach((steps, i) => {
    stats.recordFrame(frame(i * 10, steps));
  });

  const snapshot = stats.snapshot(70);
  expect(snapshot.stepsAvg).toBe(1);
  expect(snapshot.zeroStepShare).toBe(3 / 8);
  expect(snapshot.multiStepShare).toBe(2 / 8);
});

test("frames older than the window roll out", () => {
  const stats = createPerfStats(1000);
  stats.recordFrame(frame(0, 4, 0, 50));
  stats.recordFrame(frame(400, 4, 0, 50));
  const runUntil = (end: number, start: number): void => {
    for (let now = start; now <= end; now += 100) {
      stats.recordFrame(frame(now, 1, 0, 1));
    }
  };

  // The 400ms hitch is still in the window at 1000...
  runUntil(1000, 500);
  expect(stats.snapshot(1000).frameMsMax).toBe(400);

  // ...and gone by 1500, along with its steps and draw time.
  runUntil(1500, 1100);
  const snapshot = stats.snapshot(1500);
  expect(snapshot.frameMsMax).toBe(100);
  expect(snapshot.stepsAvg).toBe(1);
  expect(snapshot.drawMsAvg).toBe(1);
  expect(snapshot.fps).toBe(10);

  expect(stats.snapshot(3000).fps).toBe(0);
});
