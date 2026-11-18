import { expect, test, vi } from "vitest";
import type { Apparition } from "../sim/index.js";
import { drawApparition, joltAt } from "./apparition.js";

const STYLE: Apparition = {
  opacity: 0.6,
  shake: 2,
  jolt: { chance: 0, size: 5 },
  static: 0.4,
};

/** A canvas that records what is drawn on it, keeping its alpha and offset as a real one does. */
function canvas() {
  const saved: { globalAlpha: number; x: number; y: number }[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    x: 0,
    y: 0,
    save: vi.fn(() => {
      saved.push({ globalAlpha: ctx.globalAlpha, x: ctx.x, y: ctx.y });
    }),
    restore: vi.fn(() => {
      const last = saved.pop();
      if (last !== undefined) Object.assign(ctx, last);
    }),
    translate: vi.fn((x: number, y: number) => {
      ctx.x += x;
      ctx.y += y;
    }),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
  };
  return ctx;
}

const BODY = { x: 100, y: 100, radius: 14 };

test("an apparition is drawn see-through, trembling where it stands, under static", () => {
  const ctx = canvas();
  const drawn: { globalAlpha: number; x: number; y: number }[] = [];
  drawApparition(ctx, BODY, STYLE, 0, () => {
    drawn.push({ globalAlpha: ctx.globalAlpha, x: ctx.x, y: ctx.y });
  });
  expect(drawn).toHaveLength(1);
  const [kind] = drawn;
  expect(kind?.globalAlpha).toBeLessThanOrEqual(STYLE.opacity);
  expect(kind?.globalAlpha).toBeGreaterThanOrEqual(STYLE.opacity * 0.85);
  expect(Math.abs(kind?.x ?? Infinity)).toBeLessThanOrEqual(STYLE.shake);
  expect(Math.abs(kind?.y ?? Infinity)).toBeLessThanOrEqual(STYLE.shake);
  // The static is kept to a disc round it.
  expect(ctx.clip).toHaveBeenCalledOnce();
  expect(ctx.fillRect).toHaveBeenCalled();
  // All is put back as it was.
  expect(ctx.globalAlpha).toBe(1);
  expect(ctx.x).toBe(0);
  expect(ctx.y).toBe(0);
});

test("an apparition with no static is drawn without", () => {
  const ctx = canvas();
  drawApparition(ctx, BODY, { ...STYLE, static: 0 }, 0, () => undefined);
  expect(ctx.fillRect).not.toHaveBeenCalled();
});

test("jolting, it lurches its jolt aside, a fainter copy of it left where it stood", () => {
  const style = { ...STYLE, shake: 0, jolt: { chance: 1, size: 5 } };
  expect(Math.abs(joltAt(style, 0))).toBe(5);
  const ctx = canvas();
  const drawn: { globalAlpha: number; x: number }[] = [];
  drawApparition(ctx, BODY, style, 0, () => {
    drawn.push({ globalAlpha: ctx.globalAlpha, x: ctx.x });
  });
  expect(drawn).toHaveLength(2);
  const [left, moved] = drawn;
  expect(left?.x).toBe(0);
  expect(Math.abs(moved?.x ?? 0)).toBe(5);
  expect(left?.globalAlpha).toBeLessThan(moved?.globalAlpha ?? 0);
});

test("a jolt holds a moment, and most moments none comes at a low chance", () => {
  const style = { ...STYLE, jolt: { chance: 0.1, size: 5 } };
  expect(joltAt(style, 1000)).toBe(joltAt(style, 1010));
  const moments = Array.from({ length: 1000 }, (_, i) => joltAt(style, i * 90));
  const jolted = moments.filter((jolt) => jolt !== 0).length;
  expect(jolted).toBeGreaterThan(30);
  expect(jolted).toBeLessThan(200);
  expect(joltAt({ ...style, jolt: { chance: 0, size: 5 } }, 1000)).toBe(0);
});
