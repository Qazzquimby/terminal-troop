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
  /**
   * Fewest cells from the road every kind it brings must appear, as `roadDistanceAt` counts them:
   * 1 keeps them all off the road, and so off it as they move to where they might have arrived. A
   * kind's own `offRoad` rule overrides it. Anywhere when 0 or left out.
   */
  readonly offRoad?: number;
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
  /** Kinds it would rather appear far from; it minds none when left out. */
  readonly apart?: ApartConfig;
  /**
   * The most of it the world may hold at once: while that many are about, the spawner does not
   * pick it, and a group stops short of it. No limit when left out.
   */
  readonly most?: number;
}

/**
 * Kinds a spawn would rather keep away from. A spot nearer than `distance` to the nearest body of
 * them weighs its share of that distance: nothing touching one, half at half the distance, full
 * weight from the distance on. A preference, not a rule: only a spot touching one is never taken.
 */
export interface ApartConfig {
  /** The kinds' names, its own among them to keep away from its own kind. */
  readonly from: readonly string[];
  /** Pixels from the nearest of them past which it minds them no more. */
  readonly distance: number;
}

/** A group of a kind arriving together. */
export interface GroupConfig {
  /** Fewest in a group as a world begins; each group's size is drawn evenly between the two. */
  readonly min: number;
  /** Most in a group as a world begins. */
  readonly max: number;
  /** Furthest, in pixels, the rest of a group stands from its first. */
  readonly spread: number;
  /**
   * How the group grows as the world ages: its least and most move evenly from `min` and `max`
   * at the start to these by `by` seconds in, and hold there after. The same throughout when
   * left out.
   */
  readonly grows?: GroupGrowth;
}

/** Where a group's least and most end up as the world ages. */
interface GroupGrowth {
  /** Fewest in a group from `by` on. */
  readonly min: number;
  /** Most in a group from `by` on. */
  readonly max: number;
  /** Seconds into the world by which the group has grown to its full size. */
  readonly by: number;
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

/** How far from the road, in cells, each session's spawner keeps what it brings. */
const roadRules = new WeakMap<Session, number>();

/** `rules`, filled in with what the spawner of `game` asks of every kind it brings. */
function rulesIn(game: Session, rules: SpawnRules = {}): SpawnRules {
  return { ...rules, offRoad: rules.offRoad ?? roadRules.get(game) ?? 0 };
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
 * The names of the kinds the world's spawner brings no more often than `weight`: those whose
 * spawning weight is at most it, as rare as that or rarer. Kinds the spawner never brings, those
 * of no weight and those it does not enlist (items, traps, players), are none of them.
 */
export const kindsAsRareAs = (game: Session, weight: number): string[] =>
  arrivalsOf(game)
    .filter(({ config }) => config.weight > 0 && config.weight <= weight)
    .map((arrival) => arrival.kind);

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

/** Each kind the spawner may bring to `game`, with its radius and spawn weight. */
export function arrivingKinds(game: Session): {
  readonly kind: string;
  readonly radius: number;
  readonly weight: number;
}[] {
  return arrivalsOf(game).map(({ kind, radius, config }) => ({
    kind,
    radius,
    weight: config.weight,
  }));
}

/**
 * Brings one fresh `kind` to `at` as the spawner would, wherever that is, with none of its
 * group; false, bringing nothing, for a kind the spawner never brings.
 */
export function arrive(game: Session, kind: string, at: Point): boolean {
  const arrival = arrivalsOf(game).find((each) => each.kind === kind);
  arrival?.spawn(game, at);
  return arrival !== undefined;
}

/**
 * How strongly a kind keeping `rules` favours appearing at `at`: by its danger, more the farther
 * it is from the road and the nearer the exit's side of the world; 0 where it may not appear.
 * `radius` is the half-size of its body, for the rules that mind it.
 */
export function spawnWeight(
  game: Session,
  at: Point,
  rules: SpawnRules = {},
  radius = 0,
): number {
  return spawnAllowed(game, at, rulesIn(game, rules), radius)
    ? dangerWeight(game.world, at)
    : 0;
}

/**
 * How much a spawn keeping `apart` still favours `at`, 0..1: its distance to the nearest body
 * of the kinds it keeps from, as a share of `apart`'s distance; 1 when it keeps from none.
 */
export function apartShare(
  game: Session,
  at: Point,
  apart: ApartConfig | undefined,
): number {
  if (apart === undefined || apart.distance <= 0) return 1;
  const kinds = new Set<number>();
  for (const name of apart.from) {
    const kind = game.kindIds.get(name);
    if (kind !== undefined) kinds.add(kind);
  }
  let nearest = apart.distance;
  for (const entity of game.entities.values()) {
    if (!kinds.has(entity.kind)) continue;
    nearest = Math.min(
      nearest,
      Math.hypot(entity.x - at.x, entity.y - at.y) - entity.radius,
    );
  }
  return Math.max(0, nearest) / apart.distance;
}

function nearestPlayerDistance(game: Session, at: Point): number {
  let nearest = Infinity;
  for (const player of livingPlayers(game))
    nearest = Math.min(nearest, Math.hypot(player.x - at.x, player.y - at.y));
  return nearest;
}

/**
 * A free point where `arrival` may appear, drawn among its tries by spawn weight, less near the
 * kinds it keeps apart from, from those no player stands near enough to watch; or null when none of the tries finds one. A new world's
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
    const allowed = spawnWeight(game, at, arrival.rules, radius);
    if (allowed <= 0) continue;
    const weight = allowed * apartShare(game, at, config.apart);
    const distance = nearestPlayerDistance(game, at);
    if (distance > farthestDistance) {
      farthest = at;
      farthestDistance = distance;
    }
    if (distance < config.unseenDistance || weight <= 0) continue;
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

/**
 * A group's least and most at world time `time`, moving evenly from where they start to where
 * they grow to; fractional in between.
 */
export function groupRange(
  group: GroupConfig,
  time: number,
): { readonly min: number; readonly max: number } {
  const { grows } = group;
  if (grows === undefined) return { min: group.min, max: group.max };
  const t = grows.by > 0 ? Math.min(1, Math.max(0, time / grows.by)) : 1;
  return {
    min: group.min + (grows.min - group.min) * t,
    max: group.max + (grows.max - group.max) * t,
  };
}

/**
 * A group's size at world time `time`, drawn evenly from its least to its most. Where those are
 * fractional, as while a group grows, the draw still averages halfway between them, so the
 * average grows smoothly rather than in steps.
 */
export function groupSize(group: GroupConfig, time: number): number {
  const range = groupRange(group, time);
  const min = Math.max(1, range.min);
  const max = Math.max(min, range.max);
  return Math.floor(min + Math.random() * (max - min + 1));
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
    spawnAllowed(game, at, rulesIn(game, arrival.rules), radius) &&
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
    groupSize(group, game.worldTime) - 1,
    unseen,
    group,
  );
  for (const at of members) if (roomFor(game, arrival)) arrival.spawn(game, at);
  return true;
}

/** How many of the kind `kind` the world holds now. */
function countOf(game: Session, kind: string): number {
  const id = game.kindIds.get(kind);
  let count = 0;
  for (const entity of game.entities.values()) if (entity.kind === id) count++;
  return count;
}

/** Whether the world has room for another of `arrival`, under its most. */
function roomFor(game: Session, arrival: Arrival): boolean {
  const { most } = arrival.config;
  return most === undefined || countOf(game, arrival.kind) < most;
}

/**
 * Whether `arrival` may be picked now: it has weight, its time has come, and the world holds fewer
 * of it than its most.
 */
function eligible(game: Session, arrival: Arrival): boolean {
  const { weight, after = 0 } = arrival.config;
  return (
    Math.round(weight) > 0 && game.worldTime >= after && roomFor(game, arrival)
  );
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
      register(game) {
        roadRules.set(game, config.offRoad ?? 0);
      },
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
