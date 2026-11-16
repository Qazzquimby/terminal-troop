import { expect, test, vi } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { clockFace, clockMinutes, dayPhase, daylight, hearDay } from "./day.js";
import type { DayConfig } from "./day.js";
import { createSession } from "./session.js";

const DAY: DayConfig = {
  startHour: 8,
  midnight: 1200,
  afternoon: 600,
  night: 1020,
  volume: 0.5,
};

test("the clock runs from 8am at a world's start to midnight, and holds there", () => {
  expect(clockFace(clockMinutes(DAY, 0))).toEqual({
    digits: "8:00",
    meridiem: "AM",
  });
  // Halfway: 16 hours over, so 4pm.
  expect(clockFace(clockMinutes(DAY, 600))).toEqual({
    digits: "4:00",
    meridiem: "PM",
  });
  expect(clockFace(clockMinutes(DAY, 1200))).toEqual({
    digits: "12:00",
    meridiem: "AM",
  });
  expect(clockMinutes(DAY, 5000)).toBe(24 * 60);
  expect(clockFace(12 * 60 + 5)).toEqual({ digits: "12:05", meridiem: "PM" });
});

test("daylight is whole in the morning, recedes evenly through the afternoon, and is gone at night", () => {
  expect(dayPhase(DAY, 0)).toBe("morning");
  expect(dayPhase(DAY, 600)).toBe("afternoon");
  expect(dayPhase(DAY, 1020)).toBe("night");
  expect(daylight(DAY, 599)).toBe(1);
  expect(daylight(DAY, 600)).toBe(1);
  expect(daylight(DAY, 810)).toBeCloseTo(0.5);
  expect(daylight(DAY, 1020)).toBe(0);
  expect(daylight(DAY, 2000)).toBe(0);
});

test("the turn of the day is heard as the clock passes it, but not when it jumps past", () => {
  const sfx = testSfx();
  const play = vi.spyOn(sfx, "play");
  const game = createSession("me", "ME", "DAY", "standard", sfx, testSimConfig);
  const { afternoon, night } = testSimConfig.day;
  game.worldTime = afternoon - 0.05;
  hearDay(game);
  game.worldTime = afternoon + 0.05;
  hearDay(game);
  // A late joiner's clock jumps from morning to night: nothing.
  game.worldTime = night + 30;
  hearDay(game);
  expect(play.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
    "afternoon.mp3",
  ]);
});
