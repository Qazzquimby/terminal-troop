import type { Point, Rng, Room, TileMap, World } from "./map.js";
import { daylightNow } from "./day.js";
import { NO_FRONTS, behindDeepFront, edgeAt, frontsNow } from "./deepdark.js";
import type { Fronts } from "./deepdark.js";
import { AREA, exitDistance, isSolid } from "./map.js";
import type { Session } from "./session.js";
import { noShadows, shadowCasters, shadowsOf } from "./shadow.js";
import type { ShadowsOf } from "./shadow.js";
import { isShrouded } from "./status.js";
import {
  canSeeFrom,
  emittedLights,
  emittersNow,
  litFrom,
  wallKey,
} from "./vision.js";
import type { LightSource, VisibilityPolygon, WallFace } from "./vision.js";

/**
 * Which rooms a new world gives light fixtures, and which it gives power to light them; and
 * where sunlight never reaches.
 */
export interface RoomLightConfig {
  /** Chance each room has a light fixture. */
  readonly fixture: number;
  /** Chance each room has power, drawn room by room until the world has a power system. */
  readonly powered: number;
  /** Cells round the exit left unlit by the sun, so the players' goal is dark. */
  readonly exitShade: number;
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

/**
 * Where sunlight reaches in a world: for each cell, how far it lies from the road's centre line,
 * in cells, or -1 for one the sun never lights; and the farthest of them.
 */
interface SunReach {
  readonly distance: Float32Array;
  readonly farthest: number;
}

/** Each world's sun reach, worked out once, the first time its light is asked of. */
const sunReaches = new WeakMap<World, SunReach>();

function sunReach(world: World): SunReach {
  const known = sunReaches.get(world);
  if (known !== undefined) return known;
  const { cell, cols } = world.map;
  const { area, roadCentre, exitShade } = world.layout;
  const distance = new Float32Array(area.length).fill(-1);
  let farthest = 0;
  area.forEach((code, i) => {
    if (code !== AREA.road && code !== AREA.yard) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const at = { x: (col + 0.5) * cell, y: (row + 0.5) * cell };
    if (exitShade > 0 && exitDistance(world, at) <= exitShade) return;
    const centre = roadCentre[col];
    const off = centre === undefined ? 0 : Math.abs(row + 0.5 - centre);
    distance[i] = off;
    farthest = Math.max(farthest, off);
  });
  const reach = { distance, farthest };
  sunReaches.set(world, reach);
  return reach;
}

/**
 * Whether the sun lights the cell at `index` with `daylight` (0..1) left: out of doors, away
 * from the exit, and, as daylight recedes, near enough the road's centre line. The line is the
 * last to stay lit, and with none left nothing is.
 */
function sunlit(world: World, index: number, daylight: number): boolean {
  if (daylight <= 0) return false;
  const { distance, farthest } = sunReach(world);
  const off = distance[index] ?? -1;
  return off >= 0 && (daylight >= 1 || off <= farthest * daylight);
}

/**
 * The light of the cell at `index` of itself with `daylight` (0..1) left and the fronts as
 * `fronts` has them, or null for a dark one. Judged by the cell's centre, a cell the deepdark
 * front has passed has none, and one the darkness front has passed no sunlight.
 */
function cellLight(
  world: World,
  index: number,
  daylight: number,
  fronts: Fronts,
): AmbientLight | null {
  const { area, room, rooms } = world.layout;
  const { cols } = world.map;
  const centre = ((index % cols) + 0.5) * world.map.cell;
  const row = Math.floor(index / cols);
  if (centre < (fronts.deep[row] ?? -Infinity)) return null;
  const code = area[index];
  if (code === AREA.road || code === AREA.yard)
    return centre >= (fronts.dark[row] ?? -Infinity) &&
      sunlit(world, index, daylight)
      ? "sun"
      : null;
  if (code !== AREA.room) return null;
  const lit = rooms[room[index] ?? -1];
  return lit !== undefined && roomLit(lit) ? "fixture" : null;
}

/**
 * The light the place at `at` has of itself with `daylight` (0..1) left, whole by default, and
 * the fronts as `fronts` has them, none set out by default; or null where it is dark without
 * other light.
 */
export function ambientLightAt(
  world: World,
  at: Point,
  daylight = 1,
  fronts: Fronts = NO_FRONTS,
): AmbientLight | null {
  const { cell, cols, rows } = world.map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  if (!(col >= 0 && row >= 0 && col < cols && row < rows)) return null;
  return cellLight(world, row * cols + col, daylight, fronts);
}

/**
 * A spot of darkness something gives off: no light lights a point within `range` of it along a
 * clear line, whatever its kind, the sun's included.
 */
export interface DarkSource extends Point {
  readonly range: number;
}

/** The darkness every world entity gives off now, as its kind's `darkness` has it. */
export function darkSources(game: Session): DarkSource[] {
  const darks: DarkSource[] = [];
  for (const entity of emittersNow(game).darks) {
    if (game.entities.get(entity.id) !== entity) continue;
    const range = game.entityTypes.get(entity.kind)?.darkness(entity) ?? 0;
    if (range > 0) darks.push({ x: entity.x, y: entity.y, range });
  }
  return darks;
}

/** Each session's darkness given off, as of the step, world time and headcount it was found at. */
const darksFound = new WeakMap<
  Session,
  { step: number; time: number; count: number; darks: DarkSource[] }
>();

/**
 * The darkness every world entity gives off now, as `darkSources`, found once a step for rules
 * asked many times a step, such as every body's eyes.
 */
function darksNow(game: Session): DarkSource[] {
  const found = darksFound.get(game);
  if (
    found?.step === game.step &&
    found.time === game.worldTime &&
    found.count === game.entities.size
  )
    return found.darks;
  const darks = darkSources(game);
  darksFound.set(game, {
    step: game.step,
    time: game.worldTime,
    count: game.entities.size,
    darks,
  });
  return darks;
}

/**
 * Whether `at` is deepdark: the deepdark front has passed it, or darkness something gives off,
 * such as a gloom's, reaches it along a clear line. See `DeepdarkConfig`.
 */
export function isDeepdark(
  game: Session,
  at: Point,
  darks: readonly DarkSource[] = darksNow(game),
): boolean {
  return behindDeepFront(game, at) || inDarkness(game.world.map, darks, at);
}

/**
 * Whether `at` is deepdark or by it: as `isDeepdark`, but darkness given off counts out to its
 * range, along a clear line or not, so a wall in it counts. For whole cells, walls among them.
 */
export function nearDeepdark(
  game: Session,
  at: Point,
  darks: readonly DarkSource[] = darksNow(game),
): boolean {
  return (
    behindDeepFront(game, at) ||
    darks.some((dark) => Math.hypot(at.x - dark.x, at.y - dark.y) <= dark.range)
  );
}

/** `light` as it reaches into deepdark: out to its `deepRange`, or its whole range without one. */
export const intoDeepdark = (light: LightSource): LightSource => ({
  ...light,
  range: light.deepRange ?? light.range,
});

/** Whether any of `darks` reaches `at` along a clear line, so no light there lights it. */
export function inDarkness(
  map: TileMap,
  darks: readonly DarkSource[],
  at: Point,
): boolean {
  return darks.some((dark) => canSeeFrom(map, dark, at));
}

/**
 * Whether `at` is lit: by its place's own light, sunlight as the hour has it or a powered fixture, or by a light
 * something gives off there, such as a flashlight or the cruiser's headlights; and no darkness
 * something gives off reaches it, which no light lights. A player's own sight lights nothing.
 * Monsters ask it: they appear only where it is dark, and those that shun light avoid it. `lights`
 * and `darks` are those given off now, for a caller asking of many points at once. Where a body
 * shadows a light given off, that light does not light it, while the light config's shadows bear
 * on play; the body `ignore`, by id, casts no shadow here.
 */
export function isLit(
  game: Session,
  at: Point,
  lights?: readonly LightSource[],
  darks: readonly DarkSource[] = darkSources(game),
  ignore: string | null = null,
): boolean {
  const { world } = game;
  if (inDarkness(world.map, darks, at)) return false;
  const fronts = frontsNow(game);
  if (ambientLightAt(world, at, daylightNow(game), fronts) !== null)
    return true;
  const deep = at.x < edgeAt(fronts.deep, world.map.cell, at.y);
  const shadows = game.config.light.shadows.gameplay
    ? shadowsNow(game)
    : noShadows;
  // Found only now: most places are settled by darkness or their own light before any is needed.
  return (lights ?? emittedLights(game)).some((light) =>
    litFrom(
      world.map,
      deep ? intoDeepdark(light) : light,
      at,
      shadows(light),
      ignore,
    ),
  );
}

/**
 * Whether `at` is lit as the body `id` takes it: as `isLit` has it, but never for a shrouded body,
 * which takes the whole world for dark; and its own shadow, which goes where it goes, darkens
 * nothing to it. Whatever a body does by light should ask this.
 */
export function isLitTo(
  game: Session,
  id: string,
  at: Point,
  lights?: readonly LightSource[],
  darks?: readonly DarkSource[],
): boolean {
  return !isShrouded(game, id) && isLit(game, at, lights, darks, id);
}

/** Each session's shadows, as of the step, world time and headcount they were found at. */
const shadowsFound = new WeakMap<
  Session,
  { step: number; time: number; count: number; shadows: ShadowsOf }
>();

/**
 * The bodies that can shadow each light now, as `shadowsOf` the bodies casting shadows, found
 * once a step for rules asked many times a step, such as which bodies a stalker may hunt.
 */
function shadowsNow(game: Session): ShadowsOf {
  const found = shadowsFound.get(game);
  const count = game.entities.size + game.players.size;
  if (
    found?.step === game.step &&
    found.time === game.worldTime &&
    found.count === count
  )
    return found.shadows;
  const shadows = shadowsOf(shadowCasters(game));
  shadowsFound.set(game, {
    step: game.step,
    time: game.worldTime,
    count,
    shadows,
  });
  return shadows;
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
 * The cells within `bounds` that `kind` of ambient light lights with `daylight` (0..1) left,
 * as polygons the way traced lights are: a box for each run of them along a row, with the faces
 * of the walls round it.
 */
export function ambientPolygons(
  world: World,
  bounds: Bounds,
  kind: AmbientLight,
  daylight = 1,
  fronts: Fronts = NO_FRONTS,
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
      if (cellLight(world, row * cols + col, daylight, fronts) !== kind) {
        col++;
        continue;
      }
      const start = col;
      const walls = new Map<number, WallFace[]>();
      while (
        col <= maxCol &&
        cellLight(world, row * cols + col, daylight, fronts) === kind
      ) {
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
