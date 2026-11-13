import { registerActions } from "./actions.js";
import type { Action } from "./actions.js";
import { nearestFreePoint } from "./collision.js";
import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import type { EntityDefinition, WorldEntity } from "./entities.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { placeItem } from "./inventory.js";
import type { ItemDefinition } from "./inventory.js";
import { isAreaFree, mulberry32, randomFreePosition } from "./map.js";
import type { Point, Rng } from "./map.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import { registerWorldData } from "./world-data.js";
import type { WorldDataSet } from "./world-data.js";
import type { Controls } from "./player.js";
import type { Session } from "./session.js";
import { itemUse, registerItem } from "./use.js";
import type { ItemUse, UseSpec } from "./use.js";
import { registerWorldItems, spawnWorldItem } from "./world-items.js";

/**
 * A content entry's name, in the namespace of where it comes from: `entity/` for kinds of entity,
 * `item/` for items, `move/` for what every player can do empty-handed. The engine's own entries
 * are under `core/`, which content cannot take.
 */
export type ContentName =
  `entity/${string}` | `item/${string}` | `move/${string}`;

/**
 * What a room's world holds: kinds of entity and item, the entities a new world starts with,
 * the items each player starts with, the state each player keeps, and the events its clients
 * send each other.
 */
export interface WorldContent {
  /** Unique in a content list; the key its player state and events travel under. */
  readonly name: ContentName;
  /** The state it keeps on every player, if any. */
  readonly player?: PlayerData<unknown> | undefined;
  /** What its players can do, each sent under its name. */
  readonly actions?: readonly Action<never>[] | undefined;
  /** The state it keeps once for the world, by the key each part travels under. */
  readonly world?: WorldDataSet | undefined;
  /** The events it sends and receives, by the key each travels under. */
  readonly events?: ContentEvents | undefined;
  /**
   * Registers its kinds and items with a new session, and the items every player starts with,
   * which its local player holds until the host's record of its items reaches it.
   */
  register(game: Session): void;
  /** Spawns what a new world starts with. Runs once a world, on the first client to host it. */
  populate(game: Session): void;
  /** Acts on the local player's controls, each step, once the player has moved. */
  act?(game: Session, controls: Controls): void;
  /**
   * Runs on the host, each step, once the entities have moved: for what the world does over time,
   * such as spawning more.
   */
  step?(game: Session, dt: number): void;
}

/**
 * Registers each of `contents` with a new session, in order: first its player state and events,
 * then the rest. Throws on a name used twice.
 */
export function registerContent(
  game: Session,
  contents: readonly WorldContent[],
): void {
  const names = new Set<string>();
  for (const content of contents) {
    if (names.has(content.name))
      throw new Error(`Content name used twice: ${content.name}`);
    names.add(content.name);
    if (content.player !== undefined)
      registerPlayerData(game, content.name, content.player);
    if (content.world !== undefined)
      registerWorldData(game, content.name, content.world);
    if (content.events !== undefined)
      registerEvents(game, content.name, content.events);
    if (content.actions !== undefined)
      registerActions(game, content.name, content.actions);
    content.register(game);
    game.contents.push(content);
  }
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
 * - scatter: at random free spots seeded by the room; `data` draws from the same generator, and
 *   may read the session it spawns into
 * - rally: one at the world's rally point, where new players arrive, or at the nearest free spot
 * - a function: spawns them itself
 */
export type SpawnRule<S> =
  | (Scatter & {
      readonly at: "scatter";
      readonly data: (rng: Rng, game: Session) => S;
    })
  | { readonly at: "rally"; readonly data: S }
  | ((spawn: (at: Point, data: S) => WorldEntity, game: Session) => void);

/** A kind's definition, and where a new world puts its starting entities; none without `spawn`. */
export interface EntitySpec<S> extends EntityDefinition<S> {
  readonly spawn?: SpawnRule<S>;
  /** The state the kind keeps on every player, if any. */
  readonly player?: PlayerData<unknown>;
  /** The state the kind keeps once for the world, by the key each part travels under. */
  readonly world?: WorldDataSet;
  /** Runs on the host, each step, once the entities have moved. */
  step?(game: Session, dt: number): void;
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
  } else if (rule.at === "rally") {
    const { rally, world } = game;
    spawn(
      isAreaFree(world.map, rally.x, rally.y, radius)
        ? rally
        : nearestFreePoint(world.map, radius, rally),
      rule.data,
    );
  } else {
    const rng = mulberry32(game.seed ^ rule.seed);
    const count = scatterCount(game, rule.count);
    for (let i = 0; i < count; i++) {
      const at = scatterPoint(game, rng, radius, rule.clearance);
      spawn(at, rule.data(rng, game));
    }
  }
}

/**
 * A content entry of one kind, registered as the kind `name` and configured by the slice under
 * the same name; the entry itself is `entity/<name>`. `define` builds the kind from that slice
 * when the entry is created.
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
        name: `entity/${name}`,
        player: spec.player,
        world: spec.world,
        register(game) {
          kind.register(game);
        },
        step(game, dt) {
          spec.step?.(game, dt);
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

/** What every item spec has, usable or not. */
interface ItemBase extends Omit<ItemDefinition, "id"> {
  /** The slot each player starts with it in, if any; no two items may share one. */
  readonly startingSlot?: number;
  /** Where a new world lays it on the ground, one item each, if anywhere. */
  readonly scatter?: Scatter;
  /** The state the item keeps on every player, if any. */
  readonly player?: PlayerData<unknown>;
  /** What its players can do with it, past using it, each sent under its name. */
  readonly actions?: readonly Action<never>[];
  /** The state the item keeps once for the world, by the key each part travels under. */
  readonly world?: WorldDataSet;
  /** Acts on the local player's controls, each step, once the player has moved. */
  act?(game: Session, controls: Controls): void;
}

/** An item a player uses while it holds it, on the use control. */
interface Usable {
  /** What using it does: an action, sent as `use`. */
  readonly use: UseSpec;
  /** Draws a use of it as of sim time `time`; does nothing once the use has finished. */
  draw(ctx: CanvasRenderingContext2D, use: ItemUse, time: number): void;
}

/** An item that does nothing when used. */
interface Unusable {
  readonly use?: undefined;
}

/**
 * An item's definition, less its id, which is its content name; what using it does, if it is
 * usable; where each player starts with it, and where a new world lays it, if anywhere.
 */
export type ItemSpec = ItemBase & (Usable | Unusable);

/**
 * A content entry of one item, registered as the item id `name` and configured by the slice
 * under the same name; the entry itself is `item/<name>`. `define` builds the item from that
 * slice when the entry is created.
 */
export function defineItem<N extends string, C>(
  name: N,
  define: (config: C) => ItemSpec,
): Content<N, C> {
  return {
    name,
    create(config) {
      const spec = define(config[name]);
      const item: ItemDefinition & { readonly id: N } = {
        id: name,
        name: spec.name,
        emoji: spec.emoji,
        ...(spec.drop === undefined ? {} : { drop: spec.drop }),
      };
      const { scatter } = spec;
      const behaviour =
        spec.use === undefined
          ? undefined
          : { use: itemUse(name, spec.use), draw: spec.draw.bind(spec) };
      return {
        name: `item/${name}`,
        player: spec.player,
        world: spec.world,
        actions: [
          ...(behaviour === undefined ? [] : [behaviour.use]),
          ...(spec.actions ?? []),
        ],
        register(game) {
          registerItem(game, item, behaviour);
          registerWorldItems(game);
          if (spec.startingSlot === undefined) return;
          placeItem(game.starting, spec.startingSlot, item);
          placeItem(game.local.inventory, spec.startingSlot, item);
        },
        populate(game) {
          if (scatter === undefined) return;
          const rule: SpawnRule<null> = {
            ...scatter,
            at: "scatter",
            data: () => null,
          };
          spawnByRule(game, rule, game.config.worldItems.radius, (at) =>
            spawnWorldItem(game, at, name),
          );
        },
        act(game, controls) {
          spec.act?.(game, controls);
        },
      };
    },
  };
}
