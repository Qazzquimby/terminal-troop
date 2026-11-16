import type { z } from "zod";
import { bodyById } from "./bodies.js";
import { moveWithCollision } from "./collision.js";
import type { Entity } from "./entity.js";
import { changedData } from "./entity-delta.js";
import type { EntityChange, EntityDelta } from "./entity-delta.js";
import { isDead } from "./entity.js";
import { dealDamage, pruneHurts, settleHurts } from "./hurts.js";
import type { Interpolated, Tracked } from "./interpolation.js";
import { follow, glideToTarget } from "./interpolation.js";
import { livingPlayers } from "./ghosts.js";
import { isAreaFree } from "./map.js";
import type { Point } from "./map.js";
import { heardHealth, hearHealth, isHeld } from "./prediction.js";
import type { Session } from "./session.js";
import { isStunned, pruneStatuses } from "./status.js";
import type { LightEmission } from "./vision.js";
import type { Eyes } from "./eyes.js";
import type { VehicleSpec } from "./driving.js";
import type { Playing } from "./item-sounds.js";
import type { BoxPose, BoxSize } from "./shape.js";

export interface WorldEntity extends Entity, Interpolated, Tracked {
  readonly id: string;
  readonly kind: number;
  collides: boolean;
  grantsVision: boolean;
  ownerId: string | null;
  /** Per-kind state, parsed by the kind's `data` schema wherever the kind reads it. */
  data: unknown;
}

/**
 * A kind tag for bodies that hunters pass over: things neither alive nor worth attacking, such as
 * the cruiser, or later a land mine. Hunters see, chase and strike only bodies without it.
 */
export const INERT_TAG = "inert";

/**
 * A kind tag for items lying in the world, corpses included. Hunters pass over them as prey and
 * traps don't take them for a body, but noise an item makes (a radio, a walkie) is still heard.
 */
export const ITEM_TAG = "item";

/**
 * A kind tag for living bodies every hunter leaves be, as if they were not there: none hunts,
 * chases, notices as prey or strikes them; the snail is one. Unlike `INERT_TAG` it says nothing of
 * what the body is, so it still sets off traps, takes hurts and strikes what it touches.
 */
export const UNNOTICED_TAG = "unnoticed";

/**
 * A kind tag for kinds that shun light: they keep to the dark, steering round lit ground and
 * waking at light, unless something leaves them blind to it (`isShrouded`). A kind without it pays
 * light no mind.
 */
export const SHUNS_LIGHT_TAG = "shuns-light";

/**
 * Damage an entity deals to `target`, any body. It is down to `by`, a body's id, or to no one for
 * null; to the striking entity when left out.
 */
export interface Strike {
  readonly target: string;
  readonly amount: number;
  readonly by?: string | null;
}

/** A kind of entity, typed by the state `S` it keeps in `data`. */
export interface EntityDefinition<S> {
  readonly radius: number;
  readonly maxHealth: number;
  /**
   * How hard it is to push, in player masses: a push moves it less the heavier it is than what
   * pushes it, and Infinity makes it immovable. Left out, it weighs what a player of its size
   * would, as `massOfSize` gives.
   */
  readonly mass?: number | undefined;
  readonly collides?: boolean;
  /**
   * Whether a bar over it shows its health once it is hurt; true when left out. False for a kind
   * that must not give itself away, such as one passing for part of the world.
   */
  readonly healthBar?: boolean;
  /**
   * What else the kind is, past its name, for others to filter on, such as `INERT_TAG`. The
   * noise it makes carries them after its name, as `kindTags` gives them.
   */
  readonly tags?: readonly string[];
  /** Parses the kind's state; an entity whose data fails it is neither spawned nor kept. */
  readonly data: z.ZodType<S>;
  /** The lights it gives off, if any: one, or several, such as a car's headlights. */
  readonly light?: (
    entity: WorldEntity,
    data: S,
  ) => LightEmission | readonly LightEmission[] | null;
  /**
   * How far round it, in pixels, it gives off darkness, given its state: no light lights a point
   * it reaches along a clear line, and nothing there shows to anyone. None when left out, null or 0.
   */
  readonly darkness?: (entity: WorldEntity, data: S) => number | null;
  /**
   * How it sees, given its state: the view cone it looks down and how far it sees all round, or
   * null while it sees nothing. A kind without it is blind. A stunned entity sees nothing,
   * whatever this says; `eyesOf` sees to that.
   */
  readonly eyes?: (entity: WorldEntity, data: S, game: Session) => Eyes | null;
  /**
   * The one body that perceives it, by id, given its state; null for no body at all. Only that
   * body finds it among the living bodies (to hunt, strike, trap, shoot or bump into), hears the
   * noise it makes and, on that body's own client, sees it drawn and hears its sounds; the world
   * log of every other client leaves it out. Every body perceives a kind without it; `perceives`
   * judges it for every rule.
   */
  readonly perceivedBy?: (entity: WorldEntity, data: S) => string | null;
  /**
   * Whether it shows wherever whoever sees it has a clear line to it, down its view cone however
   * far, or within what it sees all round it, light or no light. Left out, it shows only where it
   * is lit, as any body does.
   */
  readonly seenInDark?: boolean;
  /**
   * Draws whatever of it shows over the cabin's minimap, `size` pixels square, on the client of
   * each player that perceives it. The minimap shows no entity otherwise.
   */
  readonly minimap?: (
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    data: S,
    size: number,
    now: number,
  ) => void;
  /** What makes it a vehicle a player can drive, if it is one. */
  readonly vehicle?: VehicleSpec;
  /**
   * What it plays where it is, given its state, if anything, on every client: a car radio's
   * station, say. Streamed as an item's is, following it as it moves.
   */
  readonly plays?: (
    entity: WorldEntity,
    data: S,
    game: Session,
  ) => Playing | null;
  /**
   * Its body as a box rather than the disc of `radius`, such as a car's: `length` along the way
   * it points, which `heading` gives from its state, and `width` across. Walls stop it as it
   * drives, it touches bodies and it is seen by that box. Its `radius` should be half its length.
   */
  readonly box?: BoxSize & {
    heading(entity: WorldEntity, data: S): number;
  };
  /**
   * How near, in pixels, a living player must be for it to stir. With none that near it lies
   * dormant, as a stun holds it: its kind is not run, so it stands still, sees nothing and strikes
   * nothing, and goes on from the state it had once one comes near. It can still be hurt, pushed
   * and killed, and every client still sees it. Run whoever is near when left out: for a kind that
   * roams far, or that moves without players, as one that relocates does.
   */
  readonly dormantBeyond?: number | undefined;
  /**
   * Whether it stays awake though no player is near enough, as one set on a body far off or with
   * a lit fuse; never when left out.
   */
  readonly wakeful?: (entity: WorldEntity, data: S, game: Session) => boolean;
  /** Steers the entity before it moves, and returns its next state. Runs only while hosting. */
  readonly update?: (
    entity: WorldEntity,
    data: S,
    dt: number,
    game: Session,
  ) => S;
  /** The damage the entity deals in a step, given the state `update` returned. Runs only while hosting. */
  readonly strikes?: (
    entity: WorldEntity,
    data: S,
    game: Session,
  ) => readonly Strike[];
  /**
   * What happens as the entity dies, just before it is gone, such as dropping what it carried.
   * Runs only while hosting.
   */
  readonly dies?: (entity: WorldEntity, data: S, game: Session) => void;
  readonly draw: (
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    data: S,
    now: number,
    game: Session,
  ) => void;
}

/**
 * A kind's config part saying how far off a player keeps it stirring, as `dormantBeyond` on its
 * definition has it: in pixels; always stirring when left out.
 */
export interface Dormancy {
  readonly dormantBeyond?: number;
}

/** A registered kind, its state parsed from an entity's `data` at each call. */
export interface EntityType {
  readonly radius: number;
  readonly maxHealth: number;
  /** Its declared mass, in player masses; null for one sized to its radius. */
  readonly mass: number | null;
  readonly collides: boolean;
  readonly healthBar: boolean;
  readonly tags: readonly string[];
  readonly data: z.ZodType;
  readonly vehicle: VehicleSpec | null;
  /** Its body's box, turned the way it points now; null for a kind whose body is its disc. */
  box(entity: WorldEntity): BoxPose | null;
  light(entity: WorldEntity): readonly LightEmission[];
  /** How far round it it gives off darkness, in pixels; 0 for none. */
  darkness(entity: WorldEntity): number;
  eyes(entity: WorldEntity, game: Session): Eyes | null;
  /** Whether only one body perceives it, the one `perceiver` names. */
  readonly restricted: boolean;
  /** The one body that perceives it, when `restricted`; null for none. */
  perceiver(entity: WorldEntity): string | null;
  readonly seenInDark: boolean;
  minimap(
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    size: number,
    now: number,
  ): void;
  plays(entity: WorldEntity, game: Session): Playing | null;
  /**
   * Whether it lies dormant this step: its kind has a dormant range, none of `players` stands
   * within it, and it is not wakeful.
   */
  dormant(
    entity: WorldEntity,
    players: readonly Point[],
    game: Session,
  ): boolean;
  update(entity: WorldEntity, dt: number, game: Session): void;
  strikes(entity: WorldEntity, game: Session): readonly Strike[];
  dies(entity: WorldEntity, game: Session): void;
  draw(
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    now: number,
    game: Session,
  ): void;
}

/** What a host sends of each entity: enough for any client to draw it and to go on running it. */
export interface EntitySnapshot {
  readonly id: string;
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly health: number;
  readonly data: unknown;
}

function entityType<S>(definition: EntityDefinition<S>): EntityType {
  const { data: schema } = definition;
  return {
    radius: definition.radius,
    maxHealth: definition.maxHealth,
    mass: definition.mass ?? null,
    collides: definition.collides ?? true,
    healthBar: definition.healthBar ?? true,
    tags: definition.tags ?? [],
    data: schema,
    vehicle: definition.vehicle ?? null,
    box(entity) {
      const { box } = definition;
      if (box === undefined) return null;
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return null;
      const { length, width } = box;
      return { length, width, heading: box.heading(entity, parsed.data) };
    },
    light(entity) {
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return [];
      const light = definition.light?.(entity, parsed.data) ?? [];
      return "range" in light ? [light] : light;
    },
    darkness(entity) {
      const { darkness } = definition;
      // Most kinds give off none, and pay nothing to parse their state for it.
      if (darkness === undefined) return 0;
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return 0;
      return Math.max(0, darkness(entity, parsed.data) ?? 0);
    },
    eyes(entity, game) {
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return null;
      return definition.eyes?.(entity, parsed.data, game) ?? null;
    },
    restricted: definition.perceivedBy !== undefined,
    perceiver(entity) {
      const { perceivedBy } = definition;
      if (perceivedBy === undefined) return null;
      const parsed = schema.safeParse(entity.data);
      return parsed.success ? perceivedBy(entity, parsed.data) : null;
    },
    seenInDark: definition.seenInDark ?? false,
    minimap(ctx, entity, size, now) {
      const parsed = schema.safeParse(entity.data);
      if (parsed.success)
        definition.minimap?.(ctx, entity, parsed.data, size, now);
    },
    plays(entity, game) {
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return null;
      return definition.plays?.(entity, parsed.data, game) ?? null;
    },
    dormant(entity, players, game) {
      const range = definition.dormantBeyond;
      if (range === undefined) return false;
      for (const player of players)
        if (Math.hypot(player.x - entity.x, player.y - entity.y) <= range)
          return false;
      const { wakeful } = definition;
      if (wakeful === undefined) return true;
      const parsed = schema.safeParse(entity.data);
      return !(parsed.success && wakeful(entity, parsed.data, game));
    },
    update(entity, dt, game) {
      const parsed = schema.safeParse(entity.data);
      if (parsed.success && definition.update !== undefined)
        entity.data = definition.update(entity, parsed.data, dt, game);
    },
    strikes(entity, game) {
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return [];
      return definition.strikes?.(entity, parsed.data, game) ?? [];
    },
    dies(entity, game) {
      const parsed = schema.safeParse(entity.data);
      if (parsed.success) definition.dies?.(entity, parsed.data, game);
    },
    draw(ctx, entity, now, game) {
      const parsed = schema.safeParse(entity.data);
      if (parsed.success) definition.draw(ctx, entity, parsed.data, now, game);
    },
  };
}

/**
 * Registers a kind under `name`, numbered by the order kinds are registered in, from 1. Clients
 * that register the same kinds in the same order number them alike, as snapshots need.
 */
export function registerEntityType<S>(
  game: Session,
  name: string,
  definition: EntityDefinition<S>,
): void {
  if (game.kindIds.has(name))
    throw new Error(`Entity kind already registered: ${name}`);
  if (!(definition.maxHealth > 0))
    throw new Error(`Entity kind ${name} needs a positive maxHealth.`);
  const kind = game.entityTypes.size + 1;
  game.kindIds.set(name, kind);
  game.entityTypes.set(kind, entityType(definition));
}

function placeEntity(
  game: Session,
  id: string,
  kind: number,
  type: EntityType,
  x: number,
  y: number,
  health: number,
  data: unknown,
): WorldEntity {
  const entity: WorldEntity = {
    id,
    kind,
    x,
    y,
    prevX: x,
    prevY: y,
    tx: x,
    ty: y,
    vx: 0,
    vy: 0,
    radius: type.radius,
    health: Math.min(health, type.maxHealth),
    maxHealth: type.maxHealth,
    collides: type.collides,
    grantsVision: false,
    ownerId: null,
    data,
  };
  game.entities.set(id, entity);
  const number = parseInt(id, 36);
  if (number.toString(36) === id)
    game.nextEntityId = Math.max(game.nextEntityId, number + 1);
  return entity;
}

/**
 * Spawns the kind registered as `name` at (x, y) under an id no entity in the session holds: the
 * next entity number, in base 36, short on the wire. Every client numbers on past each entity it
 * places, so a client that comes to host goes on from the numbers its last host used.
 * Throws when `data` is not the kind's state.
 */
export function spawnEntity(
  game: Session,
  name: string,
  x: number,
  y: number,
  data: unknown,
): WorldEntity {
  const kind = game.kindIds.get(name);
  const type = kind === undefined ? undefined : game.entityTypes.get(kind);
  if (kind === undefined || type === undefined)
    throw new Error(`Unregistered entity kind: ${name}`);
  const parsed = type.data.parse(data);

  const id = (game.nextEntityId++).toString(36);
  return placeEntity(game, id, kind, type, x, y, type.maxHealth, parsed);
}

/** Runs `entity`'s kind for a step: its update, then the damage it deals. */
function runKind(game: Session, entity: WorldEntity, dt: number): void {
  const type = game.entityTypes.get(entity.kind);
  type?.update(entity, dt, game);
  settleHurts(game, entity.id);
  if (!game.entities.has(entity.id)) return;
  type?.strikes(entity, game).forEach(({ target, amount, by }) => {
    const struck = bodyById(game, target);
    if (struck !== null)
      dealDamage(game, struck, amount, by === undefined ? entity.id : by);
  });
}

/**
 * Runs each entity's kind, then moves it. An entity's target follows it, so a client that
 * stops hosting eases on from where the entity is. A stunned entity's kind is not run, so it
 * stands still, sees nothing and strikes nothing, whatever its kind, and goes on from the state
 * it had once the stun ends. A dormant one, with no player near enough to stir it, stands as a
 * stunned one does.
 */
export function updateEntities(game: Session, dt: number): void {
  cullDeadEntities(game);
  pruneStatuses(game);
  pruneHurts(game);
  const players = livingPlayers(game);
  // Snapshot first: an update may spawn or remove entities.
  [...game.entities.values()].forEach((entity) => {
    if (!game.entities.has(entity.id)) return;

    if (
      isStunned(game, entity.id) ||
      game.entityTypes.get(entity.kind)?.dormant(entity, players, game) === true
    ) {
      entity.vx = 0;
      entity.vy = 0;
    } else {
      runKind(game, entity, dt);
      if (!game.entities.has(entity.id)) return;
    }

    if (entity.collides) {
      moveWithCollision(
        entity,
        entity.radius,
        dt,
        game.world.map,
        game.config.world.wallBounce,
      );
    } else {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
    }
    entity.tx = entity.x;
    entity.ty = entity.y;
  });
}

/** Removes every entity that has been destroyed, the host first letting its kind see it die. */
function cullDeadEntities(game: Session): void {
  for (const [id, entity] of game.entities) {
    if (!isDead(entity)) continue;
    if (game.hosting) game.entityTypes.get(entity.kind)?.dies(entity, game);
    game.entities.delete(id);
  }
}

/** Moves every entity no prediction holds steadily on towards the host's latest snapshot of it. */
export function followEntities(game: Session, dt: number): void {
  game.entities.forEach((entity) => {
    if (!isHeld(game, entity)) glideToTarget(entity, dt);
  });
}

/** Every entity in the session, as a host sends them: each one's data encoded by its kind. */
export function entitySnapshot(game: Session): EntitySnapshot[] {
  return [...game.entities.values()].map(({ id, kind, x, y, health, data }) => {
    const encoded = game.entityTypes.get(kind)?.data.safeEncode(data);
    return {
      id,
      kind,
      x,
      y,
      health,
      data: encoded?.success === true ? encoded.data : data,
    };
  });
}

/**
 * Takes the entities a host sent: known ones ease towards their new positions and take the new
 * health and state, and new ones appear where the entry puts them. An entry of an unregistered
 * kind, with data its kind rejects, or inside a wall that would stop it is left out. Returns the ids taken.
 */
function takeEntries(
  game: Session,
  entries: readonly EntitySnapshot[],
): Set<string> {
  const taken = new Set<string>();
  for (const { id, kind, x, y, health, data } of entries) {
    const type = game.entityTypes.get(kind);
    // A kind walls do not stop may stand in one, or off the map.
    if (
      type === undefined ||
      (type.collides && !isAreaFree(game.world.map, x, y, type.radius))
    )
      continue;
    const parsed = type.data.safeParse(data);
    if (!parsed.success) continue;

    const known = game.entities.get(id);
    if (known?.kind === kind) {
      follow(known, { x, y }, game.config.net);
      hearHealth(game, known, Math.min(health, known.maxHealth));
      known.data = parsed.data;
    } else {
      placeEntity(game, id, kind, type, x, y, health, parsed.data);
    }
    taken.add(id);
  }
  return taken;
}

/**
 * Makes the session's entities those of a host's full snapshot: each entry taken as
 * `takeEntries` does, and every other entity removed.
 */
export function applyEntitySnapshot(
  game: Session,
  snapshot: readonly EntitySnapshot[],
): void {
  const kept = takeEntries(game, snapshot);
  for (const id of [...game.entities.keys()]) {
    if (!kept.has(id)) game.entities.delete(id);
  }
}

/** The whole entry `change` makes of the entity it is for, or null when this client lacks it. */
function changedEntry(
  game: Session,
  change: EntityChange,
): EntitySnapshot | null {
  const known = game.entities.get(change.id);
  if (known === undefined) return null;
  const encoded = game.entityTypes.get(known.kind)?.data.safeEncode(known.data);
  if (encoded?.success !== true) return null;
  return {
    id: known.id,
    kind: known.kind,
    x: change.x ?? known.tx,
    y: change.y ?? known.ty,
    health: change.health ?? heardHealth(game, known),
    data: changedData(encoded.data, change),
  };
}

/**
 * Applies what a host changed since its last snapshot: each new entity, and each entity changed
 * as the change fills it in, taken as `takeEntries` does; each removed one removed. Every other
 * entity stays as it is, as does one changed that this client lacks.
 */
export function applyEntityChanges(
  game: Session,
  { added, changed, removed }: EntityDelta,
): void {
  takeEntries(game, [
    ...added,
    ...changed.flatMap((change) => changedEntry(game, change) ?? []),
  ]);
  for (const id of removed) game.entities.delete(id);
}

/**
 * Takes the entity `id` out of the world, as when something carries it off rather than destroys
 * it; the host's snapshots carry the removal to everyone. Only the host removes entities: false
 * on any other client, and when there is no such entity.
 */
export function removeEntity(game: Session, id: string): boolean {
  if (!game.hosting) return false;
  return game.entities.delete(id);
}
