export const EntityKind = { PLAYER: 0 } as const;

export const MAP_CELL = 50;
export const WORLD_COLS = 160;
export const WORLD_ROWS = 120;
export const WORLD_SEED = 1;

export const VIEW_W = 900;
export const VIEW_H = 600;
export const VISION_RAYS = 360;
export const PLAYER_VISION_ANGLE = Math.PI / 2;
export const PLAYER_LIGHT_RANGE = MAP_CELL * 4;
/** Radius of the circle around the player that is always seen and lit, behind them too. */
export const PLAYER_SURROUNDINGS_RADIUS = MAP_CELL * 1.4;

export const PLAYER_RADIUS = 14;
export const PLAYER_SPEED = 220;
export const SPRINT_MULTIPLIER = 1.8;
export const PLAYER_ACCELERATION = 1100;
export const INVENTORY_SLOTS = 12;

export const WALL_BOUNCE = 0;
export const SEND_HZ = 15;
export const STALE_S = 15;
export const FIXED_DT = 1 / 60;
/** The simulation falls at most this far behind the clock; older time is dropped. */
export const MAX_CATCH_UP_S = 30;
/** Most fixed steps one frame runs; a longer backlog spreads over the next frames. */
export const MAX_STEPS_PER_FRAME = 240;

export const STAMINA_MAX = 100;
/** Per second while sprinting: a full bar lasts 3s. */
export const STAMINA_DRAIN = STAMINA_MAX / 3;
/** Per second once regeneration starts: empty to full in 4s. */
export const STAMINA_REGEN = STAMINA_MAX / 4;
/** Seconds without sprinting before regeneration starts. */
export const STAMINA_REGEN_DELAY = 0.6;
/** After hitting 0, sprint stays locked until stamina is back to this. */
export const STAMINA_RECOVER = STAMINA_MAX * 0.3;
