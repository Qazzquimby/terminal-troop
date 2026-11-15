import { registerActions } from "./actions.js";
import type { Action } from "./actions.js";
import { nearestFreePoint } from "./collision.js";
import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import type { EntityDefinition, WorldEntity } from "./entities.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { livingPlayers } from "./ghosts.js";
import { placeItem } from "./inventory.js";
import type { ItemDefinition } from "./inventory.js";
import {
  isAreaFree,
  mulberry32,
  randomFreePosition,
  randomFreePositionIn,
} from "./map.js";
import type { Point, Rect, Rng } from "./map.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import type { LightEmission } from "./vision.js";
import { registerWorldData } from "./world-data.js";
import type { WorldDataSet } from "./world-data.js";
import type { Controls, Player } from "./player.js";
import type { Session } from "./session.js";
import { itemControl, itemUse, registerItem } from "./use.js";
import type { ControlSpec, ItemUse, UseSpec } from "./use.js";
import type { ItemLoot } from "./loot.js";
import type { ItemPlays } from "./item-sounds.js";
import { addVoiceChannel } from "./voice-routes.js";
import type { VoiceChannel } from "./voice-routes.js";

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
  /**
   * How the spots spread over the world: "x" splits its width into as many equal bands as there
   * are spots and puts one in each, anywhere free in its band, so they run evenly from left to
   * right. Anywhere at random when left out.
   */
  readonly spread?: "x";
}

/**
 * Where a new world puts a kind's starting entities:
 * - scatter: at random free spots seeded by the room; `data` draws from the same generator, and
 *   may read the session it spawns into. With `weight`, a spot is drawn among those clear of the
 *   players in proportion to its weight there; a spot weighing 0 is never taken while another is
 *   found
 * - rally: one at the world's rally point, where new players arrive, or at the nearest free spot
 * - a function: spawns them itself
 */
export type SpawnRule<S> =
  | (Scatter & {
      readonly at: "scatter";
      readonly data: (rng: Rng, game: Session) => S;
      readonly weight?: SpotWeight;
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
  /**
   * Runs as the kind is registered with a new session, after the kind itself: to enlist it with
   * what the world does for every kind, such as spawning.
   */
  register?(game: Session): void;
}

/** How strongly a scatter favours the spot `at`: 0 or more. */
type SpotWeight = (game: Session, at: Point) => number;

/** Random spots tried for each scattered entity before taking the one furthest from the players. */
const SPAWN_ATTEMPTS = 64;

function distanceToPlayers(game: Session, point: Point): number {
  let nearest = Infinity;
  for (const player of livingPlayers(game)) {
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

/** The `index`th of `count` equal bands across the world's width, its full height. */
function xBand(game: Session, index: number, count: number): Rect {
  const w = game.world.W / count;
  return { x: index * w, y: 0, w, h: game.world.H };
}

/**
 * A free spot within `band`, preferring one at least `clearance` from every player as
 * `scatterPoint` does; anywhere, as `scatterPoint` draws it, when the band has no free spot.
 */
function bandPoint(
  game: Session,
  rng: Rng,
  radius: number,
  clearance: number,
  band: Rect,
): Point {
  let best: Point | null = null;
  let bestDistance = -Infinity;
  for (
    let attempt = 0;
    attempt < SPAWN_ATTEMPTS && bestDistance < clearance;
    attempt++
  ) {
    const point = randomFreePositionIn(game.world, band, radius, rng);
    if (point === null) break;
    const distance = distanceToPlayers(game, point);
    if (distance > bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best ?? scatterPoint(game, rng, radius, clearance);
}

/** Spots drawn for each entity of a weighted scatter, among which it picks by weight. */
const WEIGHED_SPOTS = 24;

/**
 * A spot drawn among `WEIGHED_SPOTS` free spots clear of the players, each in proportion to its
 * weight; as an unweighted scatter draws one when none is clear of them or has weight.
 */
function weighedPoint(
  game: Session,
  rng: Rng,
  radius: number,
  clearance: number,
  weight: SpotWeight,
): Point {
  let chosen: Point | null = null;
  let total = 0;
  for (let attempt = 0; attempt < WEIGHED_SPOTS; attempt++) {
    const point = randomFreePosition(game.world, radius, rng);
    if (distanceToPlayers(game, point) < clearance) continue;
    const share = Math.max(0, weight(game, point));
    total += share;
    if (share > 0 && rng() * total < share) chosen = point;
  }
  return chosen ?? scatterPoint(game, rng, radius, clearance);
}

function scatterCount(game: Session, count: SpawnCount): number {
  if (typeof count === "number") return count;
  const area = (game.world.W * game.world.H) / 1_000_000;
  return Math.max(count.min, Math.round(area * count.density));
}

/**
 * Calls `place` at each spot `scatter` picks for bodies of `radius`, with the generator the spots
 * are drawn from, seeded by the room and the scatter's own seed; by `weight` among those clear of
 * the players, if it has one.
 */
export function scatterEach(
  game: Session,
  scatter: Scatter & { readonly weight?: SpotWeight | undefined },
  radius: number,
  place: (at: Point, rng: Rng) => void,
): void {
  const rng = mulberry32(game.seed ^ scatter.seed);
  const count = scatterCount(game, scatter.count);
  for (let i = 0; i < count; i++) {
    const { clearance, weight } = scatter;
    let at: Point;
    if (scatter.spread === "x")
      at = bandPoint(game, rng, radius, clearance, xBand(game, i, count));
    else if (weight === undefined)
      at = scatterPoint(game, rng, radius, clearance);
    else at = weighedPoint(game, rng, radius, clearance, weight);
    place(at, rng);
  }
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
    scatterEach(game, rule, radius, (at, rng) => {
      spawn(at, rule.data(rng, game));
    });
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
          spec.register?.(game);
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

/**
 * What every item has, kept in its config: how heavy it is, how many uses it has, and how likely
 * the world is to lay it as loot. An item's config extends this, so it is all in one place.
 */
export interface ItemTraits {
  /** How heavy it is to carry, in pounds. */
  readonly weight: number;
  /** How many uses a new one has; unlimited when left out. */
  readonly uses?: number;
  /** How likely the world is to lay it as loot; never when left out. */
  readonly loot?: ItemLoot;
}

/** What every item spec has, usable or not. */
interface ItemBase extends Omit<
  ItemDefinition,
  "id" | "weight" | "uses" | "loot"
> {
  /**
   * Its weight, uses and loot odds: its config, or the part of it that holds them. Weightless,
   * with unlimited uses and never laid as loot when left out.
   */
  readonly traits?: ItemTraits;
  /** What working its control does, on interact when there is nothing to pick up, if anything. */
  readonly control?: ControlSpec;
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
  /** What one of it plays where it is, if anything, on every client: a radio's song, say. */
  readonly plays?: ItemPlays;
  /** A way it carries voice between players past the air, if any: a walkie talkie, say. */
  readonly voice?: VoiceChannel;
  /** Runs on the host, each step, once the entities have moved: for the rules the item keeps. */
  step?(game: Session, dt: number): void;
  /**
   * Runs on every client for its own player, each step, once the player has moved: for state the
   * player keeps of its own, such as switching a flashlight off once it is no longer held.
   */
  act?(game: Session, controls: Controls): void;
  /**
   * The light it gives off while `holder` holds it, if any, such as a flashlight switched on:
   * every client draws it, and it lights the world for `isLit`.
   */
  light?(game: Session, holder: Player): LightEmission | null;
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
      const traits: Partial<ItemTraits> = spec.traits ?? {};
      const item: ItemDefinition & { readonly id: N } = {
        id: name,
        name: spec.name,
        emoji: spec.emoji,
        ...(traits.weight !== undefined && { weight: traits.weight }),
        ...(spec.drop !== undefined && { drop: spec.drop }),
        ...(spec.breaks !== undefined && { breaks: spec.breaks }),
        ...(traits.uses !== undefined && { uses: traits.uses }),
        ...(traits.loot !== undefined && { loot: traits.loot }),
      };
      const { scatter } = spec;
      const use =
        spec.use === undefined
          ? undefined
          : { use: itemUse(name, spec.use), draw: spec.draw.bind(spec) };
      const control =
        spec.control === undefined
          ? undefined
          : { control: itemControl(name, spec.control) };
      const light =
        spec.light === undefined ? undefined : { light: spec.light.bind(spec) };
      const plays =
        spec.plays === undefined ? undefined : { plays: spec.plays };
      const behaviour =
        use === undefined &&
        control === undefined &&
        light === undefined &&
        plays === undefined
          ? undefined
          : { ...use, ...control, ...light, ...plays };
      const { voice } = spec;
      return {
        name: `item/${name}`,
        player: spec.player,
        world: spec.world,
        actions: [
          ...(use === undefined ? [] : [use.use]),
          ...(control === undefined ? [] : [control.control]),
          ...(spec.actions ?? []),
        ],
        register(game) {
          registerItem(game, item, behaviour);
          registerWorldItems(game);
          if (voice !== undefined) addVoiceChannel(game, voice);
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
        step(game, dt) {
          spec.step?.(game, dt);
        },
        act(game, controls) {
          spec.act?.(game, controls);
        },
      };
    },
  };
}
