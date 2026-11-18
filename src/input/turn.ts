import type { Point } from "../sim/index.js";

/** How the mouse turns the view while the camera turns with it. */
export interface TurnConfig {
  /** Radians the view turns for each pixel the mouse moves sideways. */
  readonly sensitivity: number;
  /**
   * The ways a body may be steered once its keys are turned with the view, evenly spaced round:
   * the steer is sent on only when it changes, so a few dozen keep it from changing every step
   * the view turns.
   */
  readonly directions: number;
  /**
   * A single mouse movement further sideways than this, in pixels, is dropped: some browsers
   * report a jump of hundreds of pixels as the pointer is captured or freed.
   */
  readonly spike: number;
  /**
   * While the mouse turns the view but is not captured, it can reach the side of the game. Within
   * `band` (a fraction of the game's width) of either side, or past it, the view keeps turning
   * that way at up to `rate` radians a second, so it never stops at the edge.
   */
  readonly edge: { readonly band: number; readonly rate: number };
}

/** A sideways mouse movement, in pixels, kept to what counts: a spike counts as none. */
export function turnMovement(movementX: number, spike: number): number {
  return Number.isFinite(movementX) && Math.abs(movementX) <= spike
    ? movementX
    : 0;
}

/**
 * How hard a free pointer at `x` pushes the view round, given a game `width` wide from `left`:
 * from 0 short of `band` (a fraction of the width) from either side, up to -1 (left) or 1
 * (right) at the side and past it.
 */
export function edgePush(
  x: number,
  left: number,
  width: number,
  band: number,
): number {
  if (width <= 0 || band <= 0) return 0;
  const across = (x - left) / width;
  if (across < band) return -Math.min(1, (band - across) / band);
  if (across > 1 - band) return Math.min(1, (across - (1 - band)) / band);
  return 0;
}

/**
 * How far ahead of where it looks the aim of a turned view lies, in pixels: far enough that the
 * few pixels a body moves between steps barely bend the line to it.
 */
const AIM_AHEAD = 10_000;

/** A world point straight ahead of `from` along `heading` (radians), to aim at. */
export function aimAhead(from: Point, heading: number): Point {
  return {
    x: from.x + Math.cos(heading) * AIM_AHEAD,
    y: from.y + Math.sin(heading) * AIM_AHEAD,
  };
}

/**
 * `move`, a steer as the keys give it, made to steer the way `toWorld` turns a screen direction
 * into a world one, its direction kept to one of `directions` evenly spaced ways and its length
 * kept. No steer stays none.
 */
export function turnMove(
  move: Point,
  toWorld: (direction: Point) => Point,
  directions: number,
): Point {
  const length = Math.hypot(move.x, move.y);
  if (length === 0) return { x: 0, y: 0 };
  const world = toWorld(move);
  const step = (Math.PI * 2) / Math.max(1, Math.round(directions));
  const angle = Math.round(Math.atan2(world.y, world.x) / step) * step;
  // Clamped: rounding must never take a steer past the full ±1 the wire allows.
  const clamp = (value: number) => Math.min(1, Math.max(-1, value));
  return {
    x: clamp(Math.cos(angle) * length),
    y: clamp(Math.sin(angle) * length),
  };
}
