import { hurt } from "./actions.js";
import { solidBodiesBut } from "./collision.js";
import type { WorldEntity } from "./entities.js";
import type { Point, TileMap } from "./map.js";
import type { Session } from "./session.js";

/*
 * Doors: a kind of entity that stands in one cell of the map and, while closed, makes that cell a
 * wall for every client, so a closed door blocks bodies, sight, light and routes as a wall does.
 * Open, the cell is floor. Walls knocked down by blasts or pressing bodies spare a door's cell;
 * a door comes down when its health runs out, like any body, and leaves its cell open.
 *
 * A body steered into a closed door presses it: a kind that declares `opensDoors` opens it once it
 * has pressed `openSeconds`; any other bashes it, `bash.damage` every `bash.cooldown` seconds.
 * A player opens and closes one with the interact control.
 */

/** How a kind of door works, as it declares it on its definition. */
export interface Hinge<S> {
  /** Whether the door with state `data` is shut. */
  closed(data: S): boolean;
  /** Swings `door` shut when `close`, open otherwise, down to `by`; its own sound and noise too. */
  swing(
    game: Session,
    door: WorldEntity,
    close: boolean,
    by: string | null,
  ): void;
  /** How far from its middle a player can work it, in pixels. */
  readonly reach: number;
  /** Seconds a body that opens doors presses one before it opens. */
  readonly openSeconds: number;
  /** What a body that cannot open it does to it, pressing it. */
  readonly bash: { readonly damage: number; readonly cooldown: number };
  /** What a closed door costs a route through it, in cells walked; see `planRoute`. */
  readonly toll: number;
}

/** A door's hinge as the session holds it, its state parsed at each call. */
export interface DoorHinge extends Omit<Hinge<unknown>, "closed"> {
  closed(door: WorldEntity): boolean;
}

/** A closed door standing in one cell: which entity, and what a route through it costs. */
export interface ClosedDoor {
  readonly id: string;
  readonly toll: number;
}

/** Each map's closed doors by row-major cell, as the last `followDoors` found them. */
const closedByMap = new WeakMap<TileMap, Map<number, ClosedDoor>>();
/** Each map's door cells, open or closed, as the last `followDoors` found them. */
const doorsByMap = new WeakMap<TileMap, Set<number>>();

const NONE: ReadonlyMap<number, ClosedDoor> = new Map();

/** The closed doors of `map` by row-major cell. */
export function closedDoors(map: TileMap): ReadonlyMap<number, ClosedDoor> {
  return closedByMap.get(map) ?? NONE;
}

/** Whether a door, open or closed, stands in the cell `index` of `map`. */
export function isDoorCell(map: TileMap, index: number): boolean {
  return doorsByMap.get(map)?.has(index) ?? false;
}

/** The hinge of `entity`'s kind; null for a kind that is no door. */
export function hingeOf(game: Session, entity: WorldEntity): DoorHinge | null {
  return game.entityTypes.get(entity.kind)?.door ?? null;
}

/** The row-major cell holding `at`, or -1 off the map. */
function cellAt(map: TileMap, at: Point): number {
  const col = Math.floor(at.x / map.cell);
  const row = Math.floor(at.y / map.cell);
  if (!(col >= 0 && row >= 0 && col < map.cols && row < map.rows)) return -1;
  return row * map.cols + col;
}

/**
 * Makes each door's cell of this client's map a wall while the door is closed and floor while it
 * is open, or once it is gone: on every client, each step, from the doors it holds.
 */
export function followDoors(game: Session): void {
  const { map } = game.world;
  const before = doorsByMap.get(map) ?? new Set<number>();
  const cells = new Set<number>();
  const closed = new Map<number, ClosedDoor>();
  for (const entity of game.entities.values()) {
    const hinge = hingeOf(game, entity);
    if (hinge === null) continue;
    const index = cellAt(map, entity);
    if (index < 0) continue;
    cells.add(index);
    const shut = hinge.closed(entity);
    map.solid[index] = shut ? 1 : 0;
    if (shut) closed.set(index, { id: entity.id, toll: hinge.toll });
  }
  for (const index of before) if (!cells.has(index)) map.solid[index] = 0;
  doorsByMap.set(map, cells);
  closedByMap.set(map, closed);
}

/** The box, in pixels, of the cell `door` stands in. */
function cellBox(map: TileMap, door: Point) {
  const x = Math.floor(door.x / map.cell) * map.cell;
  const y = Math.floor(door.y / map.cell) * map.cell;
  return { x, y, w: map.cell, h: map.cell };
}

/** Whether any solid body other than `door` overlaps the cell `door` stands in. */
export function doorwayBlocked(game: Session, door: WorldEntity): boolean {
  const box = cellBox(game.world.map, door);
  return solidBodiesBut(game, door).some(
    (body) =>
      body.x + body.radius > box.x &&
      body.x - body.radius < box.x + box.w &&
      body.y + body.radius > box.y &&
      body.y - body.radius < box.y + box.h,
  );
}

/** The door `id` and its hinge; null when there is no such door. */
export function doorById(
  game: Session,
  id: string,
): { door: WorldEntity; hinge: DoorHinge } | null {
  const door = game.entities.get(id);
  if (door === undefined) return null;
  const hinge = hingeOf(game, door);
  return hinge === null ? null : { door, hinge };
}

/** How far ahead of a body, in pixels, it feels for the door it presses. */
const FEEL = 2;

/** Seconds each body has pressed the door it presses, on the host, by body id. */
const pressing = new WeakMap<
  Session,
  Map<string, { readonly door: string; readonly seconds: number }>
>();

/** The closed door the square of `body`, moved on a step of `dt` and a hair more, runs into. */
function doorAhead(
  game: Session,
  body: WorldEntity,
  dt: number,
): string | null {
  const speed = Math.hypot(body.vx, body.vy);
  if (speed === 0 || !Number.isFinite(speed)) return null;
  const { map } = game.world;
  const closed = closedDoors(map);
  if (closed.size === 0) return null;
  const x = body.x + body.vx * dt + (body.vx / speed) * FEEL;
  const y = body.y + body.vy * dt + (body.vy / speed) * FEEL;
  const half = body.radius;
  const minCol = Math.floor((x - half) / map.cell);
  const maxCol = Math.floor((x + half) / map.cell);
  const minRow = Math.floor((y - half) / map.cell);
  const maxRow = Math.floor((y + half) / map.cell);
  for (let row = minRow; row <= maxRow; row++)
    for (let col = minCol; col <= maxCol; col++) {
      if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) continue;
      const door = closed.get(row * map.cols + col);
      if (door !== undefined) return door.id;
    }
  return null;
}

/**
 * Presses `body`, as the host steps it, into the closed door its velocity carries it into, if
 * any, for a step of `dt`: one of a kind that `opens` doors opens it after pressing it the door's
 * `openSeconds`; any other bashes it as it starts pressing and every `bash.cooldown` seconds
 * after. A body pressing no door starts again from nothing.
 */
export function pressDoors(
  game: Session,
  body: WorldEntity,
  opens: boolean,
  dt: number,
): void {
  const pressed =
    pressing.get(game) ??
    new Map<string, { readonly door: string; readonly seconds: number }>();
  pressing.set(game, pressed);
  const id = doorAhead(game, body, dt);
  const found = id === null ? null : doorById(game, id);
  if (found === null) {
    pressed.delete(body.id);
    return;
  }
  const { door, hinge } = found;
  const was = pressed.get(body.id);
  const kept = was?.door === door.id ? was : undefined;
  const before = kept?.seconds ?? 0;
  const seconds = before + dt;
  if (opens) {
    if (seconds >= hinge.openSeconds) {
      hinge.swing(game, door, false, body.id);
      pressed.delete(body.id);
      return;
    }
  } else {
    const { cooldown, damage } = hinge.bash;
    const bashes =
      before === 0 ||
      Math.floor(seconds / cooldown) !== Math.floor(before / cooldown);
    if (bashes) hurt(game, door, damage, body.id);
  }
  pressed.set(body.id, { door: door.id, seconds });
}
