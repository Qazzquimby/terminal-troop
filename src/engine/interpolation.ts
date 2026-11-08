import type { Point } from "./map.js";

/** A body whose drawn position blends from where it was before the latest step. */
export interface Interpolated extends Point {
  prevX: number;
  prevY: number;
}

export function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/** Fraction of a fixed step left in the accumulator, clamped to 0..1. */
export function stepAlpha(accumulator: number, step: number): number {
  return Math.min(Math.max(accumulator / step, 0), 1);
}

/** Records the pre-step position; call once per step before anything moves. */
export function storePrevious(body: Interpolated): void {
  body.prevX = body.x;
  body.prevY = body.y;
}

/** For a body placed rather than moved, so it does not slide from its old position. */
export function snapPrevious(body: Interpolated): void {
  storePrevious(body);
}

export function renderPosition(body: Interpolated, alpha: number): Point {
  return {
    x: lerp(body.prevX, body.x, alpha),
    y: lerp(body.prevY, body.y, alpha),
  };
}
