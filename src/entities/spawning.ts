import { sumBy } from "lodash-es";
import { z } from "zod";
import {
  dangerWeight,
  isAreaFree,
  isSweepFree,
  livingPlayers,
  spawn,
  worldData,
} from "../sim/index.js";
import type { Content, Point, Session } from "../sim/index.js";
import { spawnAllowed } from "./spawn-rules.js";
import type { SpawnRules } from "./spawn-rules.js";

/**
 * How the world's spawner brings monsters, whatever their kind. Every period it rolls: some
 * chance of bringing nothing, falling as the world ages until something comes every period;
 * otherwise it picks a kind by weight among those that may come. Times are in sim seconds.
 */
export interface SpawnerConfig {
  /** Seconds between rolls. */
  readonly period: number;
  /** The chance a roll brings nothing as the world begins, from 0 to 1. */
  readonly nothing: number;
  /** Seconds into the world by which the chance of nothing has fallen evenly to 0. */
  readonly certainAfter: number;
  /**
   * A new world starts with what this many seconds of rolls would bring, each at the chance a
   * world begins with.
   */
  readonly headStart: number;
}

/** How a kind arrives through the world's spawner, and where it may appear. */
export interface SpawningConfig {
  /** Its whole-number share of the spawner's picks among the kinds that may come; 0 never. */
  readonly weight: number;
  /** Seconds into the world before it may be picked; from the start when left out. */
  readonly after?: number;
  /** Points tried for a spawn before giving it up. */
  readonly tries: number;
  /** Least distance, in pixels, a spawn keeps from every player, so none sees it appear. */
  readonly unseenDistance: number;
  /** How many arrive together in each spawn; one when left out. */
  readonly group?: GroupConfig;
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

/** A kind the spawner may bring: which kind, how big a body, how it arrives and where it may. */
interface Arrival {
  readonly kind: string;
  readonly radius: number;
  readonly config: SpawningConfig;
  /** Where it may appear, past where no kind may. */
  readonly rules?: SpawnRules | undefined;
  /** Spawns one at `at`. */
  spawn(game: Session, at: Point): void;
}

/** The kinds each session's spawner may bring, in the order they registered. */
const enlisted = new WeakMap<Session, Arrival[]>();

function arrivalsOf(game: Session): readonly Arrival[] {
  return enlisted.get(game) ?? [];
}

/** What a kind declares to arrive through the spawner. */
interface Arriving<S> {
  readonly kind: string;
  readonly radius: number;
  readonly config: SpawningConfig;
  readonly rules?: SpawnRules;
  /** A fresh one's state, seeded by `seed`, a fraction from 0 to 1. */
  fresh(seed: number, game: Session): S;
}

/**
 * The part of a kind's spec that enlists it with the world's spawner: by its weight, once its
 * time has come, wherever its rules let it appear.
 */
export function arrivals<S>(kind: Arriving<S>) {
  const arrival: Arrival = {
    kind: kind.kind,
    radius: kind.radius,
    config: kind.config,
    rules: kind.rules,
    spawn(game, at) {
      spawn(game, kind.kind, at, kind.fresh(Math.random(), game));
    },
  };
  return {
    register(game: Session) {
      enlisted.set(game, [...arrivalsOf(game), arrival]);
    },
  };
}

/**
 * How strongly a kind keeping `rules` favours appearing at `at`: by its danger, more the farther
 * it is from the road and the nearer the exit's side of the world; 0 where it may not appear.
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
 * A free point where `arrival` may appear, drawn among its tries by spawn weight from those no
 * player stands near enough to watch; or null when none of the tries finds one. A new world's
 * first, `starting`, takes the allowed point farthest from the players when none is out of
 * their sight, as a world too small to hide in, such as the dev square, still starts with some.
 * Only the host spawns, and snapshots carry what it spawned, so the draws need no shared seed.
 */
function spawnPoint(
  game: Session,
  arrival: Arrival,
  starting: boolean,
): Point | null {
  const { radius, config } = arrival;
  let chosen: Point | null = null;
  let totalWeight = 0;
  let farthest: Point | null = null;
  let farthestDistance = -1;
  for (let attempt = 0; attempt < config.tries; attempt++) {
    const at = {
      x: Math.random() * game.world.W,
      y: Math.random() * game.world.H,
    };
    if (!isAreaFree(game.world.map, at.x, at.y, radius)) continue;
    const weight = spawnWeight(game, at, arrival.rules);
    if (weight <= 0) continue;
    const distance = nearestPlayerDistance(game, at);
    if (distance > farthestDistance) {
      farthest = at;
      farthestDistance = distance;
    }
    if (distance < config.unseenDistance) continue;
    totalWeight += weight;
    if (Math.random() * totalWeight < weight) chosen = at;
  }
  return chosen ?? (starting ? farthest : null);
}

/**
 * A point where one of `kind` might arrive now, as the spawner would choose it: free, where its
 * rules let it appear, by spawn weight, out of every player's sight. Null when the kind is not
 * enlisted with this session's spawner or none of its tries finds one. For a body to move to, as
 * one that teleports.
 */
export function arrivalPoint(game: Session, kind: string): Point | null {
  const arrival = arrivalsOf(game).find((each) => each.kind === kind);
  return arrival === undefined ? null : spawnPoint(game, arrival, false);
}

/**
 * Whether a player stands near enough to `at` to watch one of `kind` come or go there: within
 * its spawn's unseen distance. False for a kind not enlisted with this session's spawner.
 */
export function watchedAt(game: Session, kind: string, at: Point): boolean {
  const arrival = arrivalsOf(game).find((each) => each.kind === kind);
  if (arrival === undefined) return false;
  return nearestPlayerDistance(game, at) < arrival.config.unseenDistance;
}

/** A group's size, drawn evenly from its least to its most. */
function groupSize(group: GroupConfig): number {
  const min = Math.max(1, Math.round(group.min));
  const max = Math.max(min, Math.round(group.max));
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Up to `count` free points within the group's spread of `leader`, each in plain reach of it,
 * clear of the leader and one another, where the kind may appear and at least `unseen` from every
 * player; a member with nowhere to stand after the tries is left out.
 */
function memberPoints(
  game: Session,
  arrival: Arrival,
  leader: Point,
  count: number,
  unseen: number,
  group: GroupConfig,
): Point[] {
  const { radius, config } = arrival;
  const { map } = game.world;
  const taken: Point[] = [leader];
  const fits = (at: Point) =>
    isAreaFree(map, at.x, at.y, radius) &&
    spawnAllowed(game, at, arrival.rules) &&
    nearestPlayerDistance(game, at) >= unseen &&
    taken.every(
      (other) => Math.hypot(other.x - at.x, other.y - at.y) >= radius * 2,
    ) &&
    isSweepFree(map, radius, leader, at);
  for (let member = 0; member < count; member++) {
    for (let attempt = 0; attempt < config.tries; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = group.spread * Math.sqrt(Math.random());
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

/**
 * Brings a group of `arrival` somewhere it may appear; false, bringing none, when its tries find
 * nowhere. A new world's first groups stand wherever they fit round their first, seen or not.
 */
function bring(game: Session, arrival: Arrival, starting: boolean): boolean {
  const leader = spawnPoint(game, arrival, starting);
  if (leader === null) return false;
  arrival.spawn(game, leader);
  const { group } = arrival.config;
  if (group === undefined) return true;
  const unseen = starting ? 0 : arrival.config.unseenDistance;
  const members = memberPoints(
    game,
    arrival,
    leader,
    groupSize(group) - 1,
    unseen,
    group,
  );
  for (const at of members) arrival.spawn(game, at);
  return true;
}

/** Whether `arrival` may be picked now: it has weight, and its time has come. */
function eligible(game: Session, arrival: Arrival): boolean {
  const { weight, after = 0 } = arrival.config;
  return Math.round(weight) > 0 && game.worldTime >= after;
}

/** One of `arrivals`, drawn in proportion to their weights; null when there are none. */
function pick(arrivals: readonly Arrival[]): Arrival | null {
  const total = sumBy(arrivals, (arrival) => Math.round(arrival.config.weight));
  let roll = Math.random() * total;
  for (const arrival of arrivals) {
    roll -= Math.round(arrival.config.weight);
    if (roll < 0) return arrival;
  }
  return null;
}

/**
 * Picks a kind by weight among those that may come, and brings a group of it. A kind that finds
 * nowhere to appear is set aside and another picked from the rest, until one comes or none is
 * left.
 */
function bringOne(game: Session, starting: boolean): void {
  let left = arrivalsOf(game).filter((arrival) => eligible(game, arrival));
  for (;;) {
    const chosen = pick(left);
    if (chosen === null) return;
    if (bring(game, chosen, starting)) return;
    left = left.filter((arrival) => arrival !== chosen);
  }
}

/** The chance a roll brings nothing at world time `time`. */
export function nothingChance(config: SpawnerConfig, time: number): number {
  const left = Math.max(0, 1 - time / config.certainAfter);
  return config.nothing * left;
}

/** One roll of the spawner as of world time `time`. */
function roll(
  game: Session,
  config: SpawnerConfig,
  time: number,
  starting: boolean,
): void {
  if (Math.random() < nothingChance(config, time)) return;
  bringOne(game, starting);
}

/** When, on the world's clock, the spawner next rolls; null until a host first steps the world. */
const clock = worldData<{ readonly nextAt: number } | null>({
  schema: z.object({ nextAt: z.number() }).nullable(),
  initial: null,
});

/**
 * The world's spawner: a roll every period, each with a falling chance of bringing nothing, and
 * otherwise a kind picked by weight among those enlisted through `arrivals` whose time has come.
 * A new world starts with what its head start of rolls would bring at the chance it begins
 * with. Kept in the world, so a new host goes on along the same clock. Runs on the host.
 */
export const spawner: Content<"spawner", SpawnerConfig> = {
  name: "spawner",
  create(all) {
    const config = all.spawner;
    return {
      name: "entity/spawner",
      world: { clock },
      register: () => undefined,
      populate(game) {
        const rolls = Math.floor(config.headStart / config.period);
        for (let i = 0; i < rolls; i++) roll(game, config, 0, true);
      },
      step(game) {
        const now = game.worldTime;
        const held = clock.get(game);
        if (held === null) {
          clock.set(game, { nextAt: now + config.period });
          return;
        }
        if (now < held.nextAt) return;
        clock.set(game, { nextAt: held.nextAt + config.period });
        roll(game, config, now, false);
      },
    };
  },
};
