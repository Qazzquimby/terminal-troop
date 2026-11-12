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
import type { WorldData } from "./world-data.js";
import type { Controls } from "./player.js";
import type { Session } from "./session.js";
import { registerItem } from "./use.js";
import type { ItemBehaviour } from "./use.js";
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
  /** The state it keeps once for the world, if any. */
  readonly world?: WorldData<unknown> | undefined;
  /** The events it sends and receives, by the key each travels under. */
  readonly events?: ContentEvents | undefined;
  /**
   * Registers its kinds and items with a new session, and stocks its local player's inventory,
   * before any snapshot reaches it.
   */
  register(game: Session): void;
  /** Spawns what a new world starts with. Runs once a world, on the first client to host it. */
  populate(game: Session): void;
  /** Acts on the local player's controls, each step, once the player has moved. */
  act?(game: Session, controls: Controls): void;
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
  /** The state the kind keeps on every player, if any. */
  readonly player?: PlayerData<unknown>;
  /** The events the kind sends and receives, by key. */
  readonly events?: ContentEvents;
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
        events: spec.events,
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

/** A stack each player starts with, in a slot of its own. */
interface StartingStack {
  readonly slot: number;
  readonly quantity: number;
}

/** What every item spec has, usable or not. */
interface ItemBase extends Omit<ItemDefinition, "id"> {
  readonly starting?: StartingStack;
  /** Where a new world lays it on the ground, one item each, if anywhere. */
  readonly scatter?: Scatter;
  /** The state the item keeps on every player, if any. */
  readonly player?: PlayerData<unknown>;
  /** The events the item sends and receives, by key. */
  readonly events?: ContentEvents;
  /** The state the item keeps once for the world, if any. */
  readonly world?: WorldData<unknown>;
  /** Acts on the local player's controls, each step, once the player has moved. */
  act?(game: Session, controls: Controls): void;
}

/** An item that does nothing when used. */
interface Unusable {
  readonly cooldown?: undefined;
}

/**
 * An item's definition, less its id, which is its content name; what using it does, if it is
 * usable; where each player starts with it, and where a new world lays it, if anywhere.
 */
export type ItemSpec = ItemBase & (ItemBehaviour | Unusable);

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
        maxStack: spec.maxStack,
        emoji: spec.emoji,
      };
      const { scatter } = spec;
      return {
        name: `item/${name}`,
        player: spec.player,
        world: spec.world,
        events: spec.events,
        register(game) {
          registerItem(
            game,
            item,
            spec.cooldown === undefined ? undefined : spec,
          );
          registerWorldItems(game);
          if (spec.starting !== undefined) {
            const { slot, quantity } = spec.starting;
            placeItem(game.local.inventory, slot, item, quantity);
          }
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
