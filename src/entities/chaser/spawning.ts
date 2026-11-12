import { z } from "zod";
import { isAreaFree, worldData } from "../../sim/index.js";
import type { Point, Session } from "../../sim/index.js";

/** How chasers keep arriving once a world has begun. Times are in sim seconds. */
export interface SpawningConfig {
  /** Seconds between spawns as the world begins. */
  readonly firstGap: number;
  /** Seconds between spawns once the ramp is over. */
  readonly lastGap: number;
  /** How long the gap takes to fall from the first to the last. */
  readonly rampSeconds: number;
  /** Most chasers alive at once; a spawn due while the world holds this many is skipped. */
  readonly maxAlive: number;
  /** Points tried for a spawn before skipping it. */
  readonly tries: number;
  /** Least distance, in pixels, a spawn keeps from every player, so none sees it appear. */
  readonly unseenDistance: number;
}

/** The kind of entity spawns favour being far from. */
const CRUISER = "cruiser";

/**
 * When, on the world's clock, spawning began and the next spawn is due; null until a host first
 * steps the world. Kept in the world so a new host goes on along the same ramp.
 */
export const spawning = worldData({
  schema: z.object({ startedAt: z.number(), nextAt: z.number() }).nullable(),
  initial: null,
});

function countOf(game: Session, kind: string): number {
  const id = game.kindIds.get(kind);
  let count = 0;
  for (const entity of game.entities.values()) if (entity.kind === id) count++;
  return count;
}

/** Where the cruiser stands, or null when the world has none. */
function cruiserAt(game: Session): Point | null {
  const id = game.kindIds.get(CRUISER);
  for (const entity of game.entities.values())
    if (entity.kind === id) return { x: entity.x, y: entity.y };
  return null;
}

function nearestPlayerDistance(game: Session, at: Point): number {
  let nearest = Infinity;
  for (const player of game.players.values())
    nearest = Math.min(nearest, Math.hypot(player.x - at.x, player.y - at.y));
  return nearest;
}

/**
 * A free point no player stands near enough to watch a spawn at, drawn so that a point twice as
 * far from the cruiser is twice as likely, or null when none of the tries finds one. Only the
 * host spawns, and snapshots carry what it spawned, so the draws need no shared seed.
 */
function unseenPoint(
  game: Session,
  radius: number,
  config: SpawningConfig,
): Point | null {
  const cruiser = cruiserAt(game);
  let chosen: Point | null = null;
  let totalWeight = 0;
  for (let attempt = 0; attempt < config.tries; attempt++) {
    const at = {
      x: Math.random() * game.world.W,
      y: Math.random() * game.world.H,
    };
    if (!isAreaFree(game.world.map, at.x, at.y, radius)) continue;
    if (nearestPlayerDistance(game, at) < config.unseenDistance) continue;
    const weight =
      cruiser === null ? 1 : Math.hypot(cruiser.x - at.x, cruiser.y - at.y) + 1;
    totalWeight += weight;
    if (Math.random() * totalWeight < weight) chosen = at;
  }
  return chosen;
}

/** The gap after a spawn due `age` seconds into spawning. */
function gapAt(age: number, config: SpawningConfig): number {
  const ramp = Math.min(1, age / config.rampSeconds);
  return config.firstGap + (config.lastGap - config.firstGap) * ramp;
}

/**
 * Spawns the next of the world's growing tide of `kind` once it is due, out of every player's
 * sight and likelier far from the cruiser; a spawn with nowhere to go, or due while the world is
 * full, is skipped. Runs on the host.
 */
export function stepSpawning(
  game: Session,
  kind: string,
  radius: number,
  config: SpawningConfig,
  spawn: (at: Point) => void,
): void {
  const now = game.worldTime;
  const held = spawning.get(game);
  if (held === null) {
    spawning.set(game, { startedAt: now, nextAt: now + config.firstGap });
    return;
  }
  if (now < held.nextAt) return;
  spawning.set(game, {
    startedAt: held.startedAt,
    nextAt: now + gapAt(now - held.startedAt, config),
  });
  if (countOf(game, kind) >= config.maxAlive) return;
  const at = unseenPoint(game, radius, config);
  if (at !== null) spawn(at);
}
