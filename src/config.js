export const Status = Object.freeze({ ALIVE: 0, DEAD: 1, SPAWNING: 2, CHOOSING: 3 });
export const EntityKind = Object.freeze({
  PLAYER: 0,
  FOOD: 1,
  RECALL_MARKER: 2,
  CLONE: 3,
  STICKY_BOMB: 4,
  ILLUSION: 5,
  ROCKET: 6,
  HOOK: 7,
  PORTAL_BLUE: 8,
  PORTAL_ORANGE: 9,
  BLINK_TRAIL: 10,
  SNAKE_SEGMENT: 11,
});
export const Shape = Object.freeze({ CIRCLE: 0, SQUARE: 1, TRIANGLE: 2 });
export const Relation = Object.freeze({ SELF: 0, ABOVE: 1, BELOW: 2 });
export const AbilitySlot = Object.freeze({ PRIMARY: "primary", SECONDARY: "secondary" });

export const NetEvent = Object.freeze({
  HELLO: "hello",
  STATE: "state",
  BYE: "bye",
  CATCH: "catch",
  FOOD_SPAWN: "food-spawn",
  FOOD_EATEN: "food-eaten",
  FOOD_SYNC: "food-sync",
  ABILITY: "ability",
  CLONE_POPPED: "clone-popped",
  IMPULSE: "impulse",
  FEAR: "fear",
  WALL_EDIT: "wall-edit",
});

/**
 * @typedef {Object} AbilityEvent
 * @property {string} id
 * @property {number} classId
 * @property {"primary"|"secondary"} slot
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} Entity
 * @property {string} id
 * @property {number} kind
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} radius
 * @property {boolean} collides
 * @property {boolean} solid
 * @property {boolean} interactive
 * @property {boolean} grantsVision
 * @property {number} [friction]
 * @property {boolean} isRemote
 * @property {number} [tx]
 * @property {number} [ty]
 * @property {string|null} [ownerId]
 * @property {number} [warningLeft]
 * @property {number} [armLeft]
 * @property {number} [lifeLeft]
 * @property {string} [name]
 * @property {import("./classes/types.js").ClassDef} [appearance]
 * @property {string|null} [targetId]
 * @property {boolean} [flying]
 * @property {number} [travelled]
 * @property {number} [toX]
 * @property {number} [toY]
 * @property {Set<string>} [inside]
 */

/**
 * @typedef {Object} Player
 * @property {number} kind
 * @property {number} radius
 * @property {boolean} collides
 * @property {boolean} solid
 * @property {boolean} interactive
 * @property {string} id
 * @property {string} name
 * @property {number} classId
 * @property {number|null} nextClassId
 * @property {number} status
 * @property {number} x
 * @property {number} y
 * @property {number} tx
 * @property {number} ty
 * @property {number} vx
 * @property {number} vy
 * @property {number} aim
 * @property {number} score
 * @property {number} scoredAt
 * @property {number} boostLeft
 * @property {number} stateTimer
 * @property {number} stunLeft
 * @property {number} lastSeen
 * @property {boolean} isDummy
 * @property {Object|null} classState
 * @property {Object} classNet
 * @property {number} fearLeft
 * @property {number} fearX
 * @property {number} fearY
 * @property {number} invulnerableLeft
 * @property {{primary: number, secondary: number}} cooldowns
 */

export const RELATION_COLORS = Object.freeze({
  [Relation.SELF]: "#5bc8ff",
  [Relation.ABOVE]: "#3ddc84",
  [Relation.BELOW]: "#ff4d4d",
});

export const FOOD_COLOR = "#3ddc84";
export const MAP_CELL = 50;
export const WALL_BOUNCE = 0.5;
export const REMOTE_SNAP_DIST = 100;
export const VISION_RAYS = 720;
export const VIEW_W = 900;
export const VIEW_H = 600;
export const SPAWN_CLEARANCE = 20;

export const SCORE_PLAYER = 10;
export const SCORE_FOOD = 6;

export const DEAD_S = 3;
export const SPAWN_INVULNERABLE_S = 3;
export const EAT_INVULNERABLE_S = 0.5;
export const SPAWN_WARNING_S = 1.5;
export const FOOD_WARNING_S = 1.5;

export const ROUND_S = 90;
export const ROUND_RESULT_S = 10;
export const ROUND_WARNING_S = 15;

export const FOOD_INTERVAL_S = 7;
export const FOOD_MAX = 4;
export const FOOD_PER_PLAYER = 3;
export const FOOD_RADIUS = 7;
export const ENTITY_FRICTION = 4;

export const BOOST_S = 0;
export const BOOST_MULT = 1.0;

export const SEND_HZ = 30;
export const STALE_S = 5;

export const SPAWN_SAMPLES = 12;
export const RANK_FLASH_S = 3;
