import { nearestFreePoint } from "./collision.js";
import type { EntityDefinition, WorldEntity } from "./entities.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { isAreaFree, mulberry32, randomFreePosition } from "./map.js";
import type { Point, Rng } from "./map.js";
import type { Session } from "./session.js";

/** What a room's world holds: kinds of entity, and the ones a new world starts with. */
export interface WorldContent {
  /** Registers its kinds with a new session, before any snapshot reaches it. */
  register(game: Session): void;
  /** Spawns what a new world starts with. Runs once a world, on the first client to host it. */
  populate(game: Session): void;
}

/**
 * An entry of the content list: turns its config slice, kept under its `name`, into a world's
 * content.
 */
export interface Content<N extends string, C> {
  readonly name: N;
  create(config: Readonly<Record<N, C>>): WorldContent;
}

type Intersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** The config a content list takes: each entry's slice under its name. */
export type ContentConfig<T extends Content<string, never>> = Intersection<
  T extends Content<infer N, infer C> ? Readonly<Record<N, C>> : never
>;

/** A kind of entity registered under its name, its spawns typed by its state. */
export interface Kind<S> {
  readonly name: string;
  register(game: Session): void;
  spawn(game: Session, at: Point, data: S): WorldEntity;
}

export function entityKind<S>(
  name: string,
  definition: EntityDefinition<S>,
): Kind<S> {
  return {
    name,
    register(game) {
      registerEntityType(game, name, definition);
    },
    spawn: (game, at, data) => spawnEntity(game, name, at.x, at.y, data),
  };
}

/** How many entities a scatter places: a fixed count, or one by the area of the world. */
type SpawnCount =
  | number
  | {
      /** Entities per million square pixels of world, rounded. */
      readonly density: number;
      /** Fewest placed, however small the world. */
      readonly min: number;
    };

/** Where a scatter puts its entities. */
export interface Scatter {
  readonly count: SpawnCount;
  /** Mixed with the room's seed to place them. */
  readonly seed: number;
  /** Least distance, in pixels, from every player each starts at, where the world has room. */
  readonly clearance: number;
}

/**
 * Where a new world puts a kind's starting entities:
 * - scatter: at random free spots seeded by the room; `data` draws from the same generator
 * - host: one beside the hosting player, `offset` from it, or at the nearest free spot
 * - a function: spawns them itself
 */
export type SpawnRule<S> =
  | (Scatter & { readonly at: "scatter"; readonly data: (rng: Rng) => S })
  | { readonly at: "host"; readonly offset: Point; readonly data: S }
  | ((spawn: (at: Point, data: S) => WorldEntity, game: Session) => void);

/** A kind's definition, and where a new world puts its starting entities; none without `spawn`. */
export interface EntitySpec<S> extends EntityDefinition<S> {
  readonly spawn?: SpawnRule<S>;
}

/** Random spots tried for each scattered entity before taking the one furthest from the players. */
const SPAWN_ATTEMPTS = 64;

function distanceToPlayers(game: Session, point: Point): number {
  let nearest = Infinity;
  for (const player of game.players.values()) {
    nearest = Math.min(
      nearest,
      Math.hypot(player.x - point.x, player.y - point.y),
    );
  }
  return nearest;
}

function scatterPoint(
  game: Session,
  rng: Rng,
  radius: number,
  clearance: number,
): Point {
  let best = randomFreePosition(game.world, radius, rng);
  let bestDistance = distanceToPlayers(game, best);
  for (
    let attempt = 1;
    attempt < SPAWN_ATTEMPTS && bestDistance < clearance;
    attempt++
  ) {
    const point = randomFreePosition(game.world, radius, rng);
    const distance = distanceToPlayers(game, point);
    if (distance > bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function scatterCount(game: Session, count: SpawnCount): number {
  if (typeof count === "number") return count;
  const area = (game.world.W * game.world.H) / 1_000_000;
  return Math.max(count.min, Math.round(area * count.density));
}

function spawnByRule<S>(
  game: Session,
  rule: SpawnRule<S>,
  radius: number,
  spawn: (at: Point, data: S) => WorldEntity,
): void {
  if (typeof rule === "function") {
    rule(spawn, game);
  } else if (rule.at === "host") {
    const target = {
      x: game.local.x + rule.offset.x,
      y: game.local.y + rule.offset.y,
    };
    const { map } = game.world;
    spawn(
      isAreaFree(map, target.x, target.y, radius)
        ? target
        : nearestFreePoint(map, radius, target),
      rule.data,
    );
  } else {
    const rng = mulberry32(game.seed ^ rule.seed);
    const count = scatterCount(game, rule.count);
    for (let i = 0; i < count; i++) {
      const at = scatterPoint(game, rng, radius, rule.clearance);
      spawn(at, rule.data(rng));
    }
  }
}

/**
 * A content entry of one kind, registered under `name` and configured by the slice under the
 * same name. `define` builds the kind from that slice once per session.
 */
export function defineEntity<N extends string, C, S>(
  name: N,
  define: (config: C) => EntitySpec<S>,
): Content<N, C> {
  return {
    name,
    create(config) {
      const spec = define(config[name]);
      const kind = entityKind(name, spec);
      return {
        register(game) {
          kind.register(game);
        },
        populate(game) {
          if (spec.spawn === undefined) return;
          spawnByRule(game, spec.spawn, spec.radius, (at, data) =>
            kind.spawn(game, at, data),
          );
        },
      };
    },
  };
}
