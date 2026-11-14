import type { Point, Rng, Room, World } from "./map.js";
import { AREA, isSolid } from "./map.js";
import type { Session } from "./session.js";
import { canSeeFrom, emittedLights, wallKey } from "./vision.js";
import type { LightSource, VisibilityPolygon, WallFace } from "./vision.js";

/** Which rooms a new world gives light fixtures, and which it gives power to light them. */
export interface RoomLightConfig {
  /** Chance each room has a light fixture. */
  readonly fixture: number;
  /** Chance each room has power, drawn room by room until the world has a power system. */
  readonly powered: number;
}

/**
 * The light a place has of itself, whoever is there: sunlight out of doors, which does not reach
 * indoors, or a light fixture in a room with power.
 */
export type AmbientLight = "sun" | "fixture";

/** A room as laid out, before it is given its lights. */
export type UnlitRoom = Omit<Room, "fixture" | "powered">;

/**
 * Which of `rooms` have power, each by `chance` alone. A stand-in for a power system, which would
 * replace this one function.
 */
export function powerRooms(
  rooms: readonly UnlitRoom[],
  chance: number,
  rng: Rng,
): boolean[] {
  return rooms.map(() => rng() < chance);
}

/** `rooms`, each given a light fixture by chance, and power by `powerRooms`. */
export function lightRooms(
  rooms: readonly UnlitRoom[],
  config: RoomLightConfig,
  rng: Rng,
): Room[] {
  const fixtures = rooms.map(() => rng() < config.fixture);
  const powered = powerRooms(rooms, config.powered, rng);
  return rooms.map((room, i) => ({
    ...room,
    fixture: fixtures[i] ?? false,
    powered: powered[i] ?? false,
  }));
}

/** Whether `room` is lit: it has a light fixture, and the power to light it. */
const roomLit = (room: Room): boolean => room.fixture && room.powered;

/** The light of the cell at `index` of itself, or null for a dark one. */
function cellLight(world: World, index: number): AmbientLight | null {
  const { area, room, rooms } = world.layout;
  const code = area[index];
  if (code === AREA.road || code === AREA.yard) return "sun";
  if (code !== AREA.room) return null;
  const lit = rooms[room[index] ?? -1];
  return lit !== undefined && roomLit(lit) ? "fixture" : null;
}

/** The light the place at `at` has of itself, or null where it is dark without other light. */
export function ambientLightAt(world: World, at: Point): AmbientLight | null {
  const { cell, cols, rows } = world.map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  if (!(col >= 0 && row >= 0 && col < cols && row < rows)) return null;
  return cellLight(world, row * cols + col);
}

/**
 * Whether `at` is lit: by its place's own light, sunlight or a powered fixture, or by a light
 * something gives off there, such as a flashlight or the cruiser's headlights. A player's own
 * sight lights nothing. Monsters ask it: they appear only where it is dark, and may later avoid or
 * seek it. `lights` are the lights given off now, for a caller asking of many points at once.
 */
export function isLit(
  game: Session,
  at: Point,
  lights: readonly LightSource[] = emittedLights(game),
): boolean {
  const { world } = game;
  if (ambientLightAt(world, at) !== null) return true;
  return lights.some((light) => canSeeFrom(world.map, light, at));
}

/** A box of the world, in pixels. */
interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The faces of the walls round the cell at `col`, `row` that face into it. */
function facesInto(
  world: World,
  col: number,
  row: number,
): [key: number, face: WallFace][] {
  const { map } = world;
  const { cell } = map;
  const left = col * cell;
  const right = (col + 1) * cell;
  const top = row * cell;
  const bottom = (row + 1) * cell;
  // Each side: the wall's offset, then its face, whose normal points back into the cell.
  const sides = [
    [
      { x: -1, y: 0 },
      { x: left, y: top },
      { x: left, y: bottom },
    ],
    [
      { x: 1, y: 0 },
      { x: right, y: top },
      { x: right, y: bottom },
    ],
    [
      { x: 0, y: -1 },
      { x: left, y: top },
      { x: right, y: top },
    ],
    [
      { x: 0, y: 1 },
      { x: left, y: bottom },
      { x: right, y: bottom },
    ],
  ] as const;
  return sides
    .filter(([step]) => isSolid(map, col + step.x, row + step.y))
    .map(([step, from, to]) => [
      wallKey(map, col + step.x, row + step.y),
      {
        from,
        to,
        normal: {
          x: step.x === 0 ? 0 : -step.x,
          y: step.y === 0 ? 0 : -step.y,
        },
      },
    ]);
}

/**
 * The cells within `bounds` that `kind` of ambient light lights, as polygons the way traced
 * lights are: a box for each run of them along a row, with the faces of the walls round it.
 */
export function ambientPolygons(
  world: World,
  bounds: Bounds,
  kind: AmbientLight,
): VisibilityPolygon[] {
  const { cell, cols, rows } = world.map;
  const minCol = Math.max(0, Math.floor(bounds.x / cell));
  const maxCol = Math.min(
    cols - 1,
    Math.floor((bounds.x + bounds.width) / cell),
  );
  const minRow = Math.max(0, Math.floor(bounds.y / cell));
  const maxRow = Math.min(
    rows - 1,
    Math.floor((bounds.y + bounds.height) / cell),
  );
  const polygons: VisibilityPolygon[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    let col = minCol;
    while (col <= maxCol) {
      if (cellLight(world, row * cols + col) !== kind) {
        col++;
        continue;
      }
      const start = col;
      const walls = new Map<number, WallFace[]>();
      while (col <= maxCol && cellLight(world, row * cols + col) === kind) {
        for (const [key, face] of facesInto(world, col, row))
          walls.set(key, [...(walls.get(key) ?? []), face]);
        col++;
      }
      const [x0, x1] = [start * cell, col * cell];
      const [y0, y1] = [row * cell, (row + 1) * cell];
      polygons.push({
        points: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
        walls,
      });
    }
  }
  return polygons;
}
