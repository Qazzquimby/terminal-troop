import { z } from "zod";
import {
  dangerWeight,
  isAreaFree,
  isSweepFree,
  livingPlayers,
  spawn,
  worldData,
} from "../sim/index.js";
import type { Point, Rng, Scatter, Session, WorldData } from "../sim/index.js";
import { spawnAllowed } from "./spawn-rules.js";
import type { SpawnRules } from "./spawn-rules.js";

/** How a monster kind keeps arriving once a world has begun. Times are in sim seconds. */
export interface SpawningConfig {
  /** Seconds between spawns as the world begins. */
  readonly firstGap: number;
  /** Seconds between spawns once the ramp is over. */
  readonly lastGap: number;
  /** How long the gap takes to fall from the first to the last. */
  readonly rampSeconds: number;
  /** Most of the kind alive at once; a spawn due while the world holds this many is skipped. */
  readonly maxAlive: number;
  /** Points tried for a spawn before skipping it. */
  readonly tries: number;
  /** Least distance, in pixels, a spawn keeps from every player, so none sees it appear. */
  readonly unseenDistance: number;
  /** How many arrive together in each spawn, and in each group a new world starts with. */
  readonly group: GroupConfig;
}

/** A group of a kind arriving together. */
interface GroupConfig {
  /** Fewest in a group; each group's size is drawn evenly between the two. */
  readonly min: number;
  /** Most in a group. */
  readonly max: number;
  /** Furthest, in pixels, the rest of a group stands from its first. */
  readonly spread: number;
}

/** When, on the world's clock, a kind's spawning began and its next spawn is due. */
type Clock = { readonly startedAt: number; readonly nextAt: number } | null;

/**
 * A kind's spawning clock: null until a host first steps the world. Kept in the world so a new
 * host goes on along the same ramp. Each kind that spawns keeps its own in its `world`.
 */
function spawningClock(): WorldData<Clock> {
  return worldData<Clock>({
    schema: z.object({ startedAt: z.number(), nextAt: z.number() }).nullable(),
    initial: null,
  });
}

/** A kind's tide of arrivals: which kind, how big a body, how it arrives and where it may. */
interface Tide {
  readonly kind: string;
  readonly radius: number;
  readonly config: SpawningConfig;
  /** Its spawning clock, from `spawningClock`. */
  readonly clock: WorldData<Clock>;
  /** Where it may appear, past where no kind may. */
  readonly rules?: SpawnRules;
}

function countOf(game: Session, kind: string): number {
  const id = game.kindIds.get(kind);
  let count = 0;
  for (const entity of game.entities.values()) if (entity.kind === id) count++;
  return count;
}

/**
 * How strongly a kind keeping `rules` favours appearing at `at`, a new world's first included: by
 * its danger, more the farther it is from the road and the nearer the exit's side of the world; 0
 * where it may not appear.
 */
export function spawnWeight(
  game: Session,
  at: Point,
  rules: SpawnRules = {},
): number {
  return spawnAllowed(game, at, rules) ? dangerWeight(game.world, at) : 0;
}

function nearestPlayerDistance(game: Session, at: Point): number {
  let nearest = Infinity;
  for (const player of livingPlayers(game))
    nearest = Math.min(nearest, Math.hypot(player.x - at.x, player.y - at.y));
  return nearest;
}

/**
 * A free point no player stands near enough to watch a spawn at, drawn among the tries by its
 * spawn weight, or null when none of the tries finds one. Only the host spawns, and snapshots
 * carry what it spawned, so the draws need no shared seed.
 */
function unseenPoint(game: Session, tide: Tide): Point | null {
  const { radius, config } = tide;
  let chosen: Point | null = null;
  let totalWeight = 0;
  for (let attempt = 0; attempt < config.tries; attempt++) {
    const at = {
      x: Math.random() * game.world.W,
      y: Math.random() * game.world.H,
    };
    if (!isAreaFree(game.world.map, at.x, at.y, radius)) continue;
    if (nearestPlayerDistance(game, at) < config.unseenDistance) continue;
    const weight = spawnWeight(game, at, tide.rules);
    if (weight <= 0) continue;
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

/** A group's size, drawn evenly from its least to its most. */
function groupSize(group: GroupConfig): number {
  const min = Math.max(1, Math.round(group.min));
  const max = Math.max(min, Math.round(group.max));
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Up to `count` free points within the group's spread of `leader`, each in plain reach of it,
 * clear of the leader and one another, and at least `unseen` from every player; a member with
 * nowhere to stand after the tries is left out.
 */
function memberPoints(
  game: Session,
  leader: Point,
  count: number,
  unseen: number,
  tide: Tide,
): Point[] {
  const { radius, config } = tide;
  const { map } = game.world;
  const taken: Point[] = [leader];
  const fits = (at: Point) =>
    isAreaFree(map, at.x, at.y, radius) &&
    spawnAllowed(game, at, tide.rules) &&
    nearestPlayerDistance(game, at) >= unseen &&
    taken.every(
      (other) => Math.hypot(other.x - at.x, other.y - at.y) >= radius * 2,
    ) &&
    isSweepFree(map, radius, leader, at);
  for (let member = 0; member < count; member++) {
    for (let attempt = 0; attempt < config.tries; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = config.group.spread * Math.sqrt(Math.random());
      const at = {
        x: leader.x + Math.cos(angle) * distance,
        y: leader.y + Math.sin(angle) * distance,
      };
      if (!fits(at)) continue;
      taken.push(at);
      break;
    }
  }
  return taken.slice(1);
}

/** Spawns a group led from `leader`, never past the most alive at once. */
function spawnGroup(
  game: Session,
  tide: Tide,
  leader: Point,
  size: number,
  spawn: (at: Point) => void,
): void {
  const { config } = tide;
  const room = Math.min(size, config.maxAlive - countOf(game, tide.kind));
  if (room <= 0) return;
  spawn(leader);
  const unseen = config.unseenDistance;
  for (const at of memberPoints(game, leader, room - 1, unseen, tide))
    spawn(at);
}

/**
 * Fills out the groups a new world starts with: each of the kind its scatter placed is joined by
 * the rest of a group drawn round it.
 */
function gatherStartingGroups(
  game: Session,
  tide: Tide,
  spawn: (at: Point) => void,
): void {
  const { kind, config } = tide;
  const id = game.kindIds.get(kind);
  const leaders = [...game.entities.values()].filter((e) => e.kind === id);
  for (const leader of leaders) {
    const room = config.maxAlive - countOf(game, kind);
    const count = Math.min(groupSize(config.group) - 1, room);
    for (const at of memberPoints(game, leader, count, 0, tide)) spawn(at);
  }
}

/** A kind that keeps arriving: its tide, less the clock, which `arrivals` makes it. */
interface Arriving<S> extends Omit<Tide, "clock"> {
  /** Where a new world puts its first. */
  readonly scatter: Scatter;
  /** A fresh one's state, seeded by `seed`, a fraction from 0 to 1. */
  fresh(seed: number, game: Session): S;
}

/**
 * The parts of a kind's spec that make it arrive: a new world's first scattered by its spawn
 * weight, its spawning clock in the world, and a step that brings more as `stepSpawning` does.
 */
export function arrivals<S>(kind: Arriving<S>) {
  const clock = spawningClock();
  const tide: Tide = { ...kind, clock };
  return {
    spawn: {
      at: "scatter" as const,
      ...kind.scatter,
      data: (rng: Rng, game: Session) => kind.fresh(rng(), game),
      weight: (game: Session, at: Point) => spawnWeight(game, at, kind.rules),
    },
    world: { spawning: clock },
    step(game: Session) {
      stepSpawning(game, tide, (at) => {
        spawn(game, kind.kind, at, kind.fresh(Math.random(), game));
      });
    },
  };
}

/**
 * Spawns the next group of the world's growing `tide` once it is due, out of every player's sight
 * and likelier far from the road and towards the exit; a spawn with nowhere to go, or due while
 * the world is full, is skipped, and a group that would overfill it comes short. As spawning
 * begins, those of the kind a new world starts with are gathered into groups too. Runs on the
 * host.
 */
function stepSpawning(
  game: Session,
  tide: Tide,
  spawn: (at: Point) => void,
): void {
  const { kind, config, clock } = tide;
  const now = game.worldTime;
  const held = clock.get(game);
  if (held === null) {
    clock.set(game, { startedAt: now, nextAt: now + config.firstGap });
    gatherStartingGroups(game, tide, spawn);
    return;
  }
  if (now < held.nextAt) return;
  clock.set(game, {
    startedAt: held.startedAt,
    nextAt: now + gapAt(now - held.startedAt, config),
  });
  if (countOf(game, kind) >= config.maxAlive) return;
  const at = unseenPoint(game, tide);
  if (at === null) return;
  spawnGroup(game, tide, at, groupSize(config.group), spawn);
}
