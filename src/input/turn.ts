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
