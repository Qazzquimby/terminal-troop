import type { Point } from "./map.js";

/** A body whose drawn position blends from where it was before the latest step. */
export interface Interpolated extends Point {
  prevX: number;
  prevY: number;
}

/** A body that follows a position reported over the network. */
export interface Tracked extends Point {
  tx: number;
  ty: number;
  /** Seconds left until it reaches its target; at it, or snapped there, when 0 or left out. */
  glide?: number;
}

/**
 * Gives `body` a new target, the latest position the host reported, to reach in `seconds` at a
 * steady speed from where it is now. A report of the target it already has changes nothing.
 * Taking somewhat longer than reports take to arrive keeps it moving steadily between them: it is
 * still on its way to one as the next arrives, rather than stopping and starting again.
 */
export function glideTo(body: Tracked, to: Point, seconds: number): void {
  if (to.x === body.tx && to.y === body.ty) return;
  body.tx = to.x;
  body.ty = to.y;
  body.glide = seconds;
}

/** How a body follows the positions its host reports, in sim seconds and pixels. */
interface Following {
  /** Seconds it takes to reach each reported position. */
  readonly glide: number;
  /** Furthest a report may be from the last before the body is placed there at once. */
  readonly snap: number;
}

/**
 * Moves `body`, a player or a world entity, towards the position `to` its host reported: gliding
 * there, or placed there at once when that is further than `snap` from the last, as for a body
 * that teleported, so it does not streak across the world.
 */
export function follow(
  body: Tracked & Interpolated,
  to: Point,
  { glide, snap }: Following,
): void {
  if (Math.hypot(to.x - body.tx, to.y - body.ty) <= snap) {
    glideTo(body, to, glide);
    return;
  }
  body.x = body.tx = body.prevX = to.x;
  body.y = body.ty = body.prevY = to.y;
  body.glide = 0;
}

/** Moves `body` a step of `dt` towards its target, at the speed that reaches it in time. */
export function glideToTarget(body: Tracked, dt: number): void {
  const left = body.glide ?? 0;
  if (left <= dt) {
    body.x = body.tx;
    body.y = body.ty;
    body.glide = 0;
    return;
  }
  const share = dt / left;
  body.x += (body.tx - body.x) * share;
  body.y += (body.ty - body.y) * share;
  body.glide = left - dt;
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
