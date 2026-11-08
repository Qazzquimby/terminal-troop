/**
 * @typedef {import("../config.js").Entity} Entity
 */

/**
 * @typedef {Object} EntityDef
 * @property {(ctx: CanvasRenderingContext2D, entity: Entity, viewer: Entity, now: number, game: Object) => void} draw
 * @property {(entity: Entity, dt: number, game: Object, net: Object) => void} [update]
 * @property {(entity: Entity, viewer: Entity, game: Object) => boolean} [isVisible]
 * @property {(entity: Entity, toucher: Entity, game: Object, net: Object) => void} [onTouch]
 * @property {boolean} [despawnWithOwner]
 * @property {boolean} [replicated]
 * @property {(owner: Entity, id: string) => Entity} [create]
 */
