import { z } from "zod";
import { effect } from "./actions.js";
import { noteRise } from "./fallen.js";
import { arrivalPoint } from "./arrival.js";
import type { Body as LivingBody } from "./bodies.js";
import { removeEntity, spawnEntity } from "./entities.js";
import type { WorldEntity } from "./entities.js";
import { isGhost } from "./ghosts.js";
import { setPlayerHealth } from "./health.js";
import { itemsOf, takeItem } from "./inventories.js";
import type { ItemState } from "./inventory.js";
import { itemInstances } from "./item-instances.js";
import type { ItemInstance } from "./item-instances.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { placePlayer } from "./steering.js";
import { putOut } from "./vehicle.js";
import type { VoiceChannel } from "./voice-routes.js";
import { worldData } from "./world-data.js";
import { itemsCanLie, soundDrop, spawnWorldItem } from "./world-items.js";

/*
 * A player whose health runs out drops everything it carried round where it stood, and its body
 * lies there as an item, its corpse, which anyone can carry. Its player is a ghost meanwhile
 * (see ghosts.ts). Content brings a corpse back to life, such as the cruiser does with one
 * brought to it, through `revive`.
 *
 * A world entity may leave a corpse too, through `layCorpse`, under a name of its choosing:
 * whatever brings a player's corpse back brings it back the same way, as the entity it recorded.
 */

/** How dying and coming back go. Distances in pixels. */
export interface DeathConfig {
  /** Furthest from where a player falls that the items it carried land. */
  readonly scatter: number;
  /** Health a revived player comes back with. */
  readonly reviveHealth: number;
}

/** The item a fallen player's body is. Content defines it: its glyph, weight and drop sound. */
export const CORPSE_ITEM = "corpse";

/** The key a corpse keeps, in its item state, the number of the body it is. */
const BODY_KEY = "body";

/** The entity a corpse rises as once brought back: its kind's name and its state then. */
const Riser = z.object({ kind: z.string().min(1).max(64), data: z.unknown() });

type Riser = z.infer<typeof Riser>;

/**
 * One fallen body that lies as a corpse: its name as it fell, the number its corpse keeps, and,
 * for a world entity's, what it rises as.
 */
const Body = z.object({
  name: z.string().max(64),
  tag: z.number().int().min(0),
  rises: Riser.optional(),
});

/** The key a world entity's body is kept under, apart from every player's. */
const entityKey = (id: string): string => `entity:${id}`;

/**
 * Every fallen body that lies as a corpse, by player id or, for a world entity's, `entityKey`,
 * and the number the next one takes. The host keeps it, and every client holds it, so a new
 * host goes on from it.
 */
export const bodies = worldData({
  schema: z.object({
    next: z.number().int().min(0),
    of: z.record(z.string(), Body),
  }),
  initial: { next: 0, of: {} },
});

/** The id of the player whose corpse keeps `state`; null for none, or one not known. */
function corpseOwner(
  game: Session,
  state: ItemState | undefined,
): string | null {
  const tag = state?.[BODY_KEY];
  if (typeof tag !== "number") return null;
  for (const [id, body] of Object.entries(bodies.get(game).of))
    if (body.tag === tag) return id;
  return null;
}

/**
 * Where player `id`'s corpse is, as this client knows it: where it lies, or where whoever carries
 * it stands. Null when it lies nowhere this client knows of: not yet laid, carried out of sight of
 * this client's record, or in a world with no items.
 */
export function corpseAt(game: Session, id: string): Point | null {
  for (const instance of itemInstances(game, CORPSE_ITEM))
    if (corpseOwner(game, instance.state) === id) return instance.at;
  return null;
}

/** The name `item` shows: a corpse is named after whose it is. */
export function itemName(
  game: Session,
  item: {
    readonly id: string;
    readonly name: string;
    readonly state?: ItemState | undefined;
  },
): string {
  if (item.id !== CORPSE_ITEM) return item.name;
  const owner = corpseOwner(game, item.state);
  const body = owner === null ? undefined : bodies.get(game).of[owner];
  return body === undefined ? item.name : `${body.name}'s corpse`;
}

/**
 * As the host, drops everything body `id` carries round `at`, as far as the configured scatter,
 * each with its drop sound: a falling player's items, or a teleported body's, left where it
 * stood. Does nothing on any other client, or in a world where items cannot lie.
 */
export function dropAll(game: Session, id: string, at: Point): void {
  if (!game.hosting || !itemsCanLie(game)) return;
  const { radius } = game.config.worldItems;
  itemsOf(game, id).forEach((item, slot) => {
    if (item === null || !takeItem(game, id, slot, item.id)) return;
    const spot = arrivalPoint(
      game.world,
      at,
      radius,
      game.config.death.scatter,
      Math.random,
    );
    const lying = spawnWorldItem(game, spot, item.id, item.left, item.state);
    soundDrop(game, item.id, spot, lying);
  });
}

/** How wide the flash where a player falls is, in its own radii. */
const FALL_FLASH = 2.5;

/**
 * As the host, lays `player`'s body: everything it carried lands round where it stood, each with
 * its drop sound, and its corpse lies there, with the corpse's drop sound and a flash.
 */
function fall(game: Session, player: Player): void {
  // One who falls inside a vehicle is put out beside it first, and falls there.
  putOut(game, player);
  const at = { x: player.x, y: player.y };
  // A world with no items has nothing to drop, and no corpse to lie.
  dropAll(game, player.id, at);
  lie(game, player.id, player.name, at, player.radius);
}

/**
 * As the host, records the body kept under `key`, named `name`, rising as `rises` if given, and
 * lays its corpse at `at`, with the corpse's drop sound and a flash as wide as `radius` calls for.
 * A world with no items records it but lays nothing.
 */
function lie(
  game: Session,
  key: string,
  name: string,
  at: Point,
  radius: number,
  rises?: Riser,
): void {
  const held = bodies.get(game);
  bodies.set(game, {
    next: held.next + 1,
    of: {
      ...held.of,
      [key]: { name, tag: held.next, ...(rises !== undefined && { rises }) },
    },
  });
  if (!itemsCanLie(game)) return;
  const corpse = spawnWorldItem(game, at, CORPSE_ITEM, undefined, {
    [BODY_KEY]: held.next,
  });
  const sound = game.itemDefinitions.get(CORPSE_ITEM)?.drop;
  effect(
    game,
    {
      at,
      ...(sound !== undefined && { sound }),
      flash: { radius: radius * FALL_FLASH, hit: true },
    },
    corpse,
  );
}

/**
 * As the host, lays the corpse of world entity `entity` where it stands, named `name`, which
 * brought back rises as `rises`: an entity of that kind with that state, standing where it is
 * brought back. For a kind whose dead come back as a fallen player does, by whatever brings a
 * player's corpse back.
 */
export function layCorpse(
  game: Session,
  entity: WorldEntity,
  name: string,
  rises: Riser,
): void {
  if (!game.hosting) return;
  const at = { x: entity.x, y: entity.y };
  lie(game, entityKey(entity.id), name, at, entity.radius, rises);
}

/**
 * As the host, each step: every player whose health has run out, and whose body does not yet lie
 * anywhere, falls. Going by the record, a host that takes over lays any body the last one missed.
 */
export function layBodies(game: Session): void {
  if (!game.hosting) return;
  const { of } = bodies.get(game);
  for (const player of game.players.values())
    if (isGhost(player) && of[player.id] === undefined) fall(game, player);
}

/** Takes every corpse of the body kept under `key` out of the world, wherever it is. */
function takeCorpses(game: Session, key: string): void {
  for (const instance of itemInstances(game, CORPSE_ITEM)) {
    if (corpseOwner(game, instance.state) !== key) continue;
    const { place } = instance;
    if ("lying" in place) removeEntity(game, place.lying.id);
    else takeItem(game, place.carrier.id, place.slot, CORPSE_ITEM);
  }
}

/** The ghost whose corpse keeps `state`; null when it is nobody's, or not a ghost in the session. */
function ghostOf(game: Session, state: ItemState | undefined): Player | null {
  const id = corpseOwner(game, state);
  const player = id === null ? undefined : game.players.get(id);
  return player !== undefined && isGhost(player) ? player : null;
}

/**
 * The world entity's body whose corpse keeps `state`, by the key it is kept under, and what it
 * rises as; null when it is no entity's.
 */
function riserOf(
  game: Session,
  state: ItemState | undefined,
): { readonly key: string; readonly rises: Riser } | null {
  const key = corpseOwner(game, state);
  const rises = key === null ? undefined : bodies.get(game).of[key]?.rises;
  return key === null || rises === undefined ? null : { key, rises };
}

/**
 * Whether the corpse that keeps `state` can be brought back to life: its player is a ghost in the
 * session, or it is a world entity's that rises again. Every client holds what this reads, so a
 * client may ask it as it predicts.
 */
export const isRevivable = (
  game: Session,
  state: ItemState | undefined,
): boolean => ghostOf(game, state) !== null || riserOf(game, state) !== null;

/** Forgets the body kept under `key`, and takes its every corpse out of the world. */
function bury(game: Session, key: string): void {
  takeCorpses(game, key);
  const held = bodies.get(game);
  bodies.set(game, {
    ...held,
    of: Object.fromEntries(
      Object.entries(held.of).filter(([owner]) => owner !== key),
    ),
  });
}

/** A spot near `at` where a body of `radius` stands. */
const standingNear = (game: Session, at: Point, radius: number): Point =>
  arrivalPoint(game.world, at, radius, game.config.arrival.spread, Math.random);

/** The radius of an entity of the kind named `kind`; null for a kind not registered. */
function kindRadius(game: Session, kind: string): number | null {
  const id = game.kindIds.get(kind);
  const type = id === undefined ? undefined : game.entityTypes.get(id);
  return type === undefined ? null : type.radius;
}

/**
 * As the host, brings the body whose corpse keeps `state` back to life by `at`, the work of body
 * `by` (null for no one): its corpse is gone, wherever it was, and it stands near `at` with
 * `health(body)` health, or the configured revive health when left out, never past its full. A
 * player's corpse brings back its ghost; a world entity's, a new entity as `layCorpse` recorded.
 * Returns the body revived; null when the corpse is nobody's, its player is not in the session
 * or not a ghost, or its entity's kind is not registered.
 */
export function revive(
  game: Session,
  state: ItemState | undefined,
  at: Point,
  by: string | null,
  health?: (body: { readonly maxHealth: number }) => number,
): LivingBody | null {
  if (!game.hosting) return null;
  const healthOf = (body: { readonly maxHealth: number }): number =>
    Math.min(body.maxHealth, health?.(body) ?? game.config.death.reviveHealth);
  const player = ghostOf(game, state);
  if (player !== null) {
    bury(game, player.id);
    setPlayerHealth(game, player, healthOf(player));
    placePlayer(game, player, standingNear(game, at, player.radius));
    noteRise(game, player, by);
    return player;
  }
  const riser = riserOf(game, state);
  const radius = riser === null ? null : kindRadius(game, riser.rises.kind);
  if (riser === null || radius === null) return null;
  bury(game, riser.key);
  const spot = standingNear(game, at, radius);
  const entity = spawnEntity(
    game,
    riser.rises.kind,
    spot.x,
    spot.y,
    riser.rises.data,
  );
  entity.health = healthOf(entity);
  noteRise(game, entity, by);
  return entity;
}

/**
 * How ghosts are heard: a ghost hears every other ghost wherever it is, as if beside it, and no
 * living player hears a ghost where it stands, only through a ghost ear (see ghost-ears.ts). A
 * ghost hears the living through the air as anyone does.
 */
export const ghostVoices: VoiceChannel = {
  routes: (_game, speaker, listener) =>
    isGhost(speaker) && isGhost(listener) ? [{ at: null, via: "air" }] : [],
  hides: (_game, speaker, listener) => isGhost(speaker) && !isGhost(listener),
};

/**
 * The corpses lying or carried anywhere whose players are ghosts in the session, and so can be
 * brought back with `revive`.
 */
export const ghostCorpses = (game: Session): ItemInstance[] =>
  itemInstances(game, CORPSE_ITEM).filter(
    (instance) => ghostOf(game, instance.state) !== null,
  );
