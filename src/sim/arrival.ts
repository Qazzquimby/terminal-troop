import { isSweepFree, nearestFreePoint } from "./collision.js";
import type { Point, Rng, World } from "./map.js";
import { isAreaFree, mulberry32, randomFreePosition } from "./map.js";

/** Where players arrive in a world they have not been in. */
export interface ArrivalConfig {
  /** Farthest a new player starts from the rally point, in pixels. */
  readonly spread: number;
}

/** Mixed with the room's seed to place the rally point. */
const RALLY_SEED = 0x5a11e;

/** Random spots tried round the rally point before taking the nearest free one. */
const ARRIVAL_ATTEMPTS = 32;

/**
 * The world's rally point: a free spot, seeded by the room, so every client in the room finds
 * the same one without hearing from the others. Room for a body of `clearance` half-size.
 */
export function rallyPoint(
  world: World,
  seed: number,
  clearance: number,
): Point {
  return randomFreePosition(world, clearance, mulberry32(seed ^ RALLY_SEED));
}

/**
 * Where a body of `clearance` half-size arriving at `rally` starts: a random free spot, at least
 * its width and at most `spread` from it, in plain sight of it; the nearest free spot to
 * it if none is found.
 */
export function arrivalPoint(
  world: World,
  rally: Point,
  clearance: number,
  spread: number,
  rng: Rng,
): Point {
  const { map } = world;
  const near = Math.min(clearance * 2, spread);
  for (let attempt = 0; attempt < ARRIVAL_ATTEMPTS; attempt++) {
    const angle = rng() * Math.PI * 2;
    const distance = near + rng() * (spread - near);
    const point = {
      x: rally.x + Math.cos(angle) * distance,
      y: rally.y + Math.sin(angle) * distance,
    };
    if (isSweepFree(map, clearance, rally, point)) return point;
  }
  return nearestFreePoint(map, clearance, rally);
}

/** Whether a body of `clearance` half-size can stand at `point`, inside the world on free floor. */
export function canStandAt(
  world: World,
  point: Point,
  clearance: number,
): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    isAreaFree(world.map, point.x, point.y, clearance)
  );
}
