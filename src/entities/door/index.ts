import { z } from "zod";
import {
  AREA,
  changeEntity,
  defineEntity,
  effect,
  hurtSinceLastStep,
  INERT_TAG,
  mulberry32,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Hinge,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import type { SpawnRule } from "../../sim/index.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const openUrl = new URL("./sfx/open.wav", import.meta.url).href;
const closeUrl = new URL("./sfx/close.wav", import.meta.url).href;
const hitUrl = new URL("./sfx/hit.wav", import.meta.url).href;
const breakUrl = new URL("./sfx/break.wav", import.meta.url).href;

/** How doors are laid in a new world, and how they stand up to the bodies that meet them. */
export interface DoorConfig {
  /** Half its cell: it fills the cell it stands in. */
  readonly radius: number;
  readonly maxHealth: number;
  /** Mixed with the room's seed to choose which doorways get doors, and how they are left. */
  readonly seed: number;
  /** Share of the world's doorways, 0..1, that get a door: every cell of the doorway one each. */
  readonly frequency: number;
  /** Share of the doors laid, 0..1, that a new world leaves shut. */
  readonly closedShare: number;
  /** How far from its middle a player can open or close one, in pixels. */
  readonly reach: number;
  /** Seconds a body that opens doors presses one before it swings open. */
  readonly openSeconds: number;
  /** What a body that cannot open one does to it, pressing it: damage, every `cooldown` seconds. */
  readonly bash: { readonly damage: number; readonly cooldown: number };
  /** What a closed one costs a route through it, in cells walked, as `planRoute` takes it. */
  readonly toll: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries, in pixels. */
  readonly sounds: {
    readonly swing: number;
    readonly hit: number;
    readonly break: number;
  };
}

const NAME = "door";

/**
 * A door's state, which every client reads, to wall its cell off and to draw it:
 * - open: whether it stands open
 * - across: whether the way through it runs left to right, its wall up and down; else top to
 *   bottom
 */
export const DoorState = z.object({ open: z.boolean(), across: z.boolean() });

export type DoorState = z.output<typeof DoorState>;

interface Sounds {
  readonly open: Sound;
  readonly close: Sound;
  readonly hit: Sound;
  readonly break: Sound;
}

const WOOD = { face: "#6b4a2b", frame: "#3d2914", knob: "#c9a447" } as const;

/** The top-left corner of the cell `at` stands in. */
function corner(cell: number, at: Point): Point {
  return {
    x: Math.floor(at.x / cell) * cell,
    y: Math.floor(at.y / cell) * cell,
  };
}

/**
 * Shut, a slab of wood filling its cell, framed, its knob towards the middle; open, a plank swung
 * back against the hinge side of its doorway.
 */
function drawDoor(
  ctx: CanvasRenderingContext2D,
  cell: number,
  entity: WorldEntity,
  state: DoorState,
): void {
  const { x, y } = corner(cell, entity);
  const plank = Math.max(3, cell * 0.12);
  ctx.fillStyle = WOOD.frame;
  if (state.open) {
    // Hinged at the top, or the left, swung flat against the wall.
    if (state.across) ctx.fillRect(x, y, cell, plank);
    else ctx.fillRect(x, y, plank, cell);
    return;
  }
  ctx.fillRect(x, y, cell, cell);
  const inset = plank / 2;
  ctx.fillStyle = WOOD.face;
  ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
  ctx.fillStyle = WOOD.frame;
  const lines = 3;
  for (let i = 1; i < lines; i++) {
    const at = (cell * i) / lines;
    if (state.across) ctx.fillRect(x + inset, y + at, cell - inset * 2, 1);
    else ctx.fillRect(x + at, y + inset, 1, cell - inset * 2);
  }
  ctx.fillStyle = WOOD.knob;
  ctx.beginPath();
  const knob = state.across
    ? { x: x + cell / 2, y: y + cell * 0.8 }
    : { x: x + cell * 0.8, y: y + cell / 2 };
  ctx.arc(knob.x, knob.y, Math.max(2, cell * 0.06), 0, Math.PI * 2);
  ctx.fill();
}

/** Whether the cell at `col`, `row` of the world's layout is wall, the world's edge counting. */
function wallAt(game: Session, col: number, row: number): boolean {
  const { map, layout } = game.world;
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  return layout.area[row * map.cols + col] === AREA.wall;
}

/** The doorways of the world: each a run of door cells side by side, row-major indices. */
function doorways(game: Session): number[][] {
  const { map, layout } = game.world;
  const { cols, rows } = map;
  const seen = new Uint8Array(cols * rows);
  const found: number[][] = [];
  for (let start = 0; start < layout.area.length; start++) {
    if (seen[start] === 1 || layout.area[start] !== AREA.door) continue;
    const way: number[] = [];
    const queue = [start];
    seen[start] = 1;
    for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
      way.push(index);
      const col = index % cols;
      const row = Math.floor(index / cols);
      for (const [c, r] of [
        [col - 1, row],
        [col + 1, row],
        [col, row - 1],
        [col, row + 1],
      ] as const) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const next = r * cols + c;
        if (seen[next] === 1 || layout.area[next] !== AREA.door) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    found.push(way.sort((a, b) => a - b));
  }
  return found;
}

/**
 * Lays doors in a share of the world's doorways, seeded by the room: one in each cell of a doorway
 * chosen, some shut, some open.
 */
function layDoors(config: DoorConfig): SpawnRule<DoorState> {
  return (spawn, game) => {
    const { cell, cols } = game.world.map;
    const rng = mulberry32(game.seed ^ config.seed);
    for (const way of doorways(game)) {
      if (rng() >= config.frequency) continue;
      const open = rng() >= config.closedShare;
      for (const index of way) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const across = wallAt(game, col, row - 1) && wallAt(game, col, row + 1);
        spawn(
          { x: (col + 0.5) * cell, y: (row + 0.5) * cell },
          { open, across },
        );
      }
    }
  };
}

/** The door's hinge: swinging it sets its state and makes its sound, and the noise it carries. */
function hinge(config: DoorConfig, sounds: Sounds): Hinge<DoorState> {
  return {
    closed: (state) => !state.open,
    swing(game, door, close) {
      changeEntity(game, door, (data) => ({
        ...DoorState.parse(data),
        open: !close,
      }));
      effect(
        game,
        {
          at: { x: door.x, y: door.y },
          sound: close ? sounds.close : sounds.open,
          noise: config.sounds.swing,
        },
        door,
      );
    },
    reach: config.reach,
    openSeconds: config.openSeconds,
    bash: config.bash,
    toll: config.toll,
  };
}

function definition(config: DoorConfig): EntityDefinition<DoorState> {
  const sounds: Sounds = {
    open: sound({ url: openUrl, range: config.sounds.swing }),
    close: sound({ url: closeUrl, range: config.sounds.swing }),
    hit: sound({ url: hitUrl, range: config.sounds.hit }),
    break: sound({ url: breakUrl, range: config.sounds.break }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    mass: Infinity,
    // Its cell is a wall while it is shut, and floor while it is open; it is no body to bump.
    collides: false,
    tags: [INERT_TAG],
    data: DoorState,
    door: hinge(config, sounds),
    update(entity, state, _dt, game) {
      if (hurtSinceLastStep(game, entity.id) !== null)
        effect(
          game,
          {
            at: { x: entity.x, y: entity.y },
            sound: sounds.hit,
            flash: { radius: config.radius * 0.6, hit: true },
          },
          entity,
        );
      return state;
    },
    dies(entity, _state, game) {
      effect(
        game,
        {
          at: { x: entity.x, y: entity.y },
          sound: sounds.break,
          noise: config.sounds.break,
          flash: { radius: config.radius * 1.5, hit: false },
        },
        entity,
      );
    },
    draw(ctx, entity, state, _now, game) {
      drawDoor(ctx, game.world.map.cell, entity, state);
    },
  };
}

/**
 * A door: a wooden one fills a cell of a doorway, laid in a share of the world's doorways as it
 * is made, some shut and some open. Shut, its cell is a wall to everything: bodies, sight, light
 * and routes. A player opens or shuts it with the interact control, loudly; a body steered into it
 * shut opens it after a moment if its kind opens doors, and bashes it otherwise, until it breaks.
 * Blasts hurt it as they would any body; the walls they knock down spare it. It breaks open as it
 * dies.
 */
export const door = defineEntity(NAME, (config: DoorConfig) => ({
  ...definition(config),
  spawn: layDoors(config),
}));
