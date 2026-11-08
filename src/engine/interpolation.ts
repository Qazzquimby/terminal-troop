import type { Point } from "./map.js";

/** A body whose drawn position blends from where it was before the latest step. */
export interface Interpolated extends Point {
  prevX: number;
  prevY: number;
}

/** A body that also turns; its drawn facing blends along the shortest arc. */
export interface Facing {
  aim: number;
  prevAim: number;
}

/** Any body a step can move: always a position, and a facing when it has one. */
export type Moving = Interpolated & Partial<Facing>;

export function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/** Wraps an angle in radians into [-π, π]. */
export function wrapAngle(angle: number): number {
  return angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));
}

/** Blends between two angles along the shortest arc, wrapped into [-π, π]. */
export function lerpAngle(from: number, to: number, alpha: number): number {
  return wrapAngle(from + wrapAngle(to - from) * alpha);
}

/** Fraction of a fixed step left in the accumulator, clamped to 0..1. */
export function stepAlpha(accumulator: number, step: number): number {
  return Math.min(Math.max(accumulator / step, 0), 1);
}

/** Records the pre-step position and facing; call once per step before anything moves. */
export function storePrevious(body: Moving): void {
  body.prevX = body.x;
  body.prevY = body.y;
  if (body.aim !== undefined) body.prevAim = body.aim;
}

/** For a body placed rather than moved, so it does not slide from its old position. */
export function snapPrevious(body: Moving): void {
  storePrevious(body);
}

export function renderPosition(body: Interpolated, alpha: number): Point {
  return {
    x: lerp(body.prevX, body.x, alpha),
    y: lerp(body.prevY, body.y, alpha),
  };
}

export function renderAim(body: Facing, alpha: number): number {
  return lerpAngle(body.prevAim, body.aim, alpha);
}
