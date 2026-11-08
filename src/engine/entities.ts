import type { Body } from "./collision.js";
import { moveWithCollision } from "./collision.js";
import type { Session } from "./session.js";
import type { LightEmission } from "./vision.js";

export interface WorldEntity extends Body {
  readonly id: string;
  readonly kind: number;
  radius: number;
  collides: boolean;
  grantsVision: boolean;
  ownerId: string | null;
  /** Per-kind state. Narrow it with a schema inside the kind's update/draw. */
  data: unknown;
}

export interface EntityDefinition {
  readonly radius: number;
  readonly collides?: boolean;
  readonly light?: (entity: WorldEntity) => LightEmission | null;
  readonly update?: (entity: WorldEntity, dt: number, game: Session) => void;
  readonly draw: (
    ctx: CanvasRenderingContext2D,
    entity: WorldEntity,
    now: number,
    game: Session,
  ) => void;
}

/** @public */
export function registerEntityType(
  game: Session,
  kind: number,
  definition: EntityDefinition,
): void {
  if (!Number.isInteger(kind) || kind < 1 || game.entityTypes.has(kind)) {
    throw new Error("Entity kinds must be unique positive integers.");
  }
  game.entityTypes.set(kind, definition);
}

/** @public */
export function spawnEntity(
  game: Session,
  kind: number,
  x: number,
  y: number,
  data: unknown = {},
): WorldEntity {
  const definition = game.entityTypes.get(kind);
  if (definition === undefined)
    throw new Error(`Unregistered entity kind: ${String(kind)}`);

  const entity: WorldEntity = {
    id: `${game.localId}:${String(game.nextEntityId++)}`,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: definition.radius,
    collides: definition.collides ?? true,
    grantsVision: false,
    ownerId: null,
    data,
  };

  game.entities.set(entity.id, entity);
  return entity;
}

export function updateEntities(game: Session, dt: number): void {
  // Snapshot first: an update may spawn or remove entities.
  [...game.entities.values()].forEach((entity) => {
    if (!game.entities.has(entity.id)) return;

    game.entityTypes.get(entity.kind)?.update?.(entity, dt, game);
    if (!game.entities.has(entity.id)) return;

    if (entity.collides) {
      moveWithCollision(entity, entity.radius, dt, game.world.map);
    } else {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
    }
  });
}
