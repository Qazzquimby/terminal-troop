import { expect, test } from "vitest";
import { ACTIONS, WHEEL, createActionState, toControls } from "./actions.js";
import { createButtonSource } from "./buttons.js";
import { createWheelNotches } from "./wheel.js";

const CONFIG = { notch: 40, line: 16, page: 600, idleMs: 250 };
const PIXEL = 0;
const LINE = 1;

test("one click of a wheel that reports a big delta is one notch", () => {
  const wheel = createWheelNotches(CONFIG);
  expect(wheel.scroll(100, PIXEL, 0)).toBe(1);
  expect(wheel.scroll(-100, PIXEL, 500)).toBe(-1);
  expect(wheel.scroll(400, PIXEL, 1000)).toBe(1);
});

test("a wheel that reports lines counts them as pixels", () => {
  const wheel = createWheelNotches(CONFIG);
  expect(wheel.scroll(3, LINE, 0)).toBe(1);
  expect(wheel.scroll(-3, LINE, 500)).toBe(-1);
});

test("a trackpad's small deltas add up to one notch", () => {
  const wheel = createWheelNotches(CONFIG);
  const notches = [10, 10, 10, 10, 10, 10, 10, 10, 10].map((dy, i) =>
    wheel.scroll(dy, PIXEL, i * 16),
  );
  expect(notches).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test("turning back, or pausing, forgets a part-notch", () => {
  const wheel = createWheelNotches(CONFIG);
  expect(wheel.scroll(30, PIXEL, 0)).toBe(0);
  expect(wheel.scroll(-30, PIXEL, 10)).toBe(0);
  expect(wheel.scroll(-30, PIXEL, 20)).toBe(-1);
  expect(wheel.scroll(30, PIXEL, 30)).toBe(0);
  expect(wheel.scroll(30, PIXEL, 1000)).toBe(0);
});

test("horizontal-only scroll is no notch", () => {
  const wheel = createWheelNotches(CONFIG);
  expect(wheel.scroll(0, PIXEL, 0)).toBe(0);
});

test("a notch taps its wheel key: down steps to the next slot, up to the previous, for one step", () => {
  const state = createActionState();
  const buttons = createButtonSource(state, ACTIONS, "play");
  const tap = (code: string, time: number) => {
    buttons.keyDown(code, false, time);
    buttons.keyUp(code, time);
  };
  const cycle = (until: number) =>
    toControls(state.consume(until), { x: 0, y: 0 }).cycle;
  tap(WHEEL.down, 1);
  expect(cycle(10)).toBe(1);
  expect(cycle(20)).toBe(0);
  tap(WHEEL.up, 21);
  expect(cycle(30)).toBe(-1);
  tap(WHEEL.down, 31);
  tap(WHEEL.down, 32);
  expect(cycle(40)).toBe(1);
});

test("the wheel switches nothing in the menu", () => {
  const buttons = createButtonSource(createActionState(), ACTIONS, "menu");
  expect(buttons.actionsFor(WHEEL.down)).toEqual([]);
  expect(buttons.actionsFor(WHEEL.up)).toEqual([]);
});
