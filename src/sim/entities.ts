import type { z } from "zod";
import { moveWithCollision } from "./collision.js";
import type { Entity } from "./entity.js";
import { isDead } from "./entity.js";
import { hurtPlayer } from "./health.js";
import type { Interpolated, Tracked } from "./interpolation.js";
import { easeToTarget } from "./interpolation.js";
import { isAreaFree } from "./map.js";
import type { Session } from "./session.js";
import type { LightEmission } from "./vision.js";

export interface WorldEntity extends Entity, Interpolated, Tracked {
  readonly id: string;
  readonly kind: number;
  collides: boolean;
  grantsVision: boolean;
  ownerId: string | null;
  /** Per-kind state, parsed by the kind's `data` schema wherever the kind reads it. */
  data: unknown;
  /** `data` as of this client's last cue. */
  cued: unknown;
}

/** Damage an entity deals to the player `target`. */
export interface Strike {
  readonly target: string;
  readonly amount: number;
}

/** A kind of entity, typed by the state `S` it keeps in `data`. */
export interface EntityDefinition<S> {
  readonly radius: number;
  readonly maxHealth: number;
  readonly collides?: boolean;
  /** Parses the kind's state; an entity whose data fails it is neither spawned nor kept. */
  readonly data: z.ZodType<S>;
  readonly light?: (entity: WorldEntity, data: S) => LightEmission | null;
  /** Steers the entity before it moves, and returns its next state. Runs only while hosting. */
  readonly update?: (
    entity: WorldEntity,
    data: S,
    dt: number,
    game: Session,
  ) => S;
  /**
   * Plays what changed from `previous` to `next` for this client's listener. Runs on every
   * client, at most once a frame, however many steps or snapshots the change spans.
   */
  readonly cue?: (
    entity: WorldEntity,
    previous: S,
    next: S,
    game: Session,
  ) => void;
  /** The damage the entity deals in a step, given the state `update` returned. Runs only while hosting. */
  readonly strikes?: (
    entity: WorldEntity,
    data: S,
    game: Session,
  ) => readonly Strike[];
  readonly draw: (
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    data: S,
    now: number,
    game: Session,
  ) => void;
}

/** A registered kind, its state parsed from an entity's `data` at each call. */
export interface EntityType {
  readonly radius: number;
  readonly maxHealth: number;
  readonly collides: boolean;
  readonly data: z.ZodType;
  light(entity: WorldEntity): LightEmission | null;
  update(entity: WorldEntity, dt: number, game: Session): void;
  strikes(entity: WorldEntity, game: Session): readonly Strike[];
  cue(entity: WorldEntity, game: Session): void;
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
    collides: definition.collides ?? true,
    data: schema,
    light(entity) {
      const parsed = schema.safeParse(entity.data);
      if (!parsed.success) return null;
      return definition.light?.(entity, parsed.data) ?? null;
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
    cue(entity, game) {
      if (definition.cue === undefined) return;
      const previous = schema.safeParse(entity.cued);
      const next = schema.safeParse(entity.data);
      if (previous.success && next.success)
        definition.cue(entity, previous.data, next.data, game);
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
    cued: data,
  };
  game.entities.set(id, entity);
  return entity;
}

/**
 * Spawns the kind registered as `name` at (x, y) under an id no entity in the session holds.
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

  let id = `${game.localId}:${String(game.nextEntityId++)}`;
  while (game.entities.has(id))
    id = `${game.localId}:${String(game.nextEntityId++)}`;
  return placeEntity(game, id, kind, type, x, y, type.maxHealth, parsed);
}

/**
 * Runs each entity's kind, then moves it. An entity's target follows it, so a client that
 * stops hosting eases on from where the entity is.
 */
export function updateEntities(game: Session, dt: number): void {
  cullDeadEntities(game);
  // Snapshot first: an update may spawn or remove entities.
  [...game.entities.values()].forEach((entity) => {
    if (!game.entities.has(entity.id)) return;

    const type = game.entityTypes.get(entity.kind);
    type?.update(entity, dt, game);
    if (!game.entities.has(entity.id)) return;
    type?.strikes(entity, game).forEach(({ target, amount }) => {
      const player = game.players.get(target);
      if (player !== undefined) hurtPlayer(game, player, amount);
    });

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

/** Removes every entity that has been destroyed. */
function cullDeadEntities(game: Session): void {
  for (const [id, entity] of game.entities) {
    if (isDead(entity)) game.entities.delete(id);
  }
}

/** Eases every entity towards the host's latest snapshot of it. */
export function followEntities(game: Session, dt: number): void {
  const amount = 1 - Math.exp(-game.config.net.smoothing * dt);
  game.entities.forEach((entity) => {
    easeToTarget(entity, amount);
  });
}

/** Plays what changed in each entity since the last call, then takes its state as heard. */
export function cueEntities(game: Session): void {
  game.entities.forEach((entity) => {
    game.entityTypes.get(entity.kind)?.cue(entity, game);
    entity.cued = entity.data;
  });
}

/** Every entity in the session, as a host sends them. */
export function entitySnapshot(game: Session): EntitySnapshot[] {
  return [...game.entities.values()].map(
    ({ id, kind, x, y, health, data }) => ({ id, kind, x, y, health, data }),
  );
}

/**
 * Makes the session's entities those of a host's snapshot. Known entities ease towards their
 * new positions and take the new health and state; new ones appear where the snapshot puts them; the
 * rest are removed. An entry of an unregistered kind, with data its kind rejects, or inside
 * a wall is left out.
 */
export function applyEntitySnapshot(
  game: Session,
  snapshot: readonly EntitySnapshot[],
): void {
  const kept = new Set<string>();
  for (const { id, kind, x, y, health, data } of snapshot) {
    const type = game.entityTypes.get(kind);
    if (type === undefined || !isAreaFree(game.world.map, x, y, type.radius))
      continue;
    const parsed = type.data.safeParse(data);
    if (!parsed.success) continue;

    const known = game.entities.get(id);
    if (known?.kind === kind) {
      known.tx = x;
      known.ty = y;
      known.health = Math.min(health, known.maxHealth);
      known.data = parsed.data;
    } else {
      placeEntity(game, id, kind, type, x, y, health, parsed.data);
    }
    kept.add(id);
  }
  for (const id of [...game.entities.keys()]) {
    if (!kept.has(id)) game.entities.delete(id);
  }
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
