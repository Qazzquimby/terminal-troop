import { moveWithCollision } from "./collision.js";

/**
 * @typedef {Object} WorldEntity
 * @property {string} id
 * @property {number} kind
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} radius
 * @property {boolean} collides
 * @property {boolean} grantsVision
 * @property {string|null} ownerId
 * @property {Object} data
 */

/**
 * @typedef {Object} EntityDefinition
 * @property {number} radius
 * @property {boolean} [collides]
 * @property {(entity: WorldEntity, dt: number, game: Object) => void} [update]
 * @property {(ctx: CanvasRenderingContext2D, entity: WorldEntity, now: number, game: Object) => void} draw
 */

/**
 * @param {Object} game
 * @param {number} kind
 * @param {EntityDefinition} definition
 */
export function registerEntityType(game, kind, definition) {
  if (!Number.isInteger(kind) || kind < 1 || game.entityTypes.has(kind)) {
    throw new Error("Entity kinds must be unique positive integers.");
  }
  game.entityTypes.set(kind, definition);
}

export function spawnEntity(game, kind, x, y, data = {}) {
  const definition = game.entityTypes.get(kind);
  if (!definition) throw new Error(`Unregistered entity kind: ${kind}`);

  const entity = {
    id: `${game.localId}:${game.nextEntityId++}`,
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

export function updateEntities(game, dt) {
  for (const entity of [...game.entities.values()]) {
    if (!game.entities.has(entity.id)) continue;

    const definition = game.entityTypes.get(entity.kind);
    definition.update?.(entity, dt, game);
    if (!game.entities.has(entity.id)) continue;

    if (entity.collides) {
      moveWithCollision(entity, entity.radius, dt, game.world.map);
    } else {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
    }
  }
}
