export const EntityKind = Object.freeze({ PLAYER: 0 });

export const NetEvent = Object.freeze({
  HELLO: "hello",
  STATE: "state",
  BYE: "bye",
});

export const MAP_CELL = 50;
export const WORLD_COLS = 160;
export const WORLD_ROWS = 120;
export const WORLD_SEED = 1;

export const VIEW_W = 900;
export const VIEW_H = 600;
export const VISION_RAYS = 360;

export const PLAYER_RADIUS = 14;
export const PLAYER_SPEED = 220;
export const PLAYER_ACCELERATION = 1100;
export const INVENTORY_SLOTS = 12;

export const WALL_BOUNCE = 0;
export const SEND_HZ = 15;
export const STALE_S = 15;
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_S = 0.1;
