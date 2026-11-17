import { bodyById, destroyWalls, effect, hurt } from "../sim/index.js";
import type { Session, Sound, TileMap, WorldEntity } from "../sim/index.js";
import { preyNear } from "./hunt.js";
import type { Prey } from "./hunt.js";

/**
 * A burst: how far it reaches, in pixels, and the damage it deals to a body where it goes off and
 * to one at its edge, falling evenly between. Any kind that goes off, an exploder or a land mine,
 * declares one.
 */
export interface Blast {
  readonly radius: number;
  readonly centre: number;
  readonly edge: number;
}

/** The damage `blast` deals to a body `distance` from where it goes off, its middle to theirs. */
export function blastDamage(distance: number, blast: Blast): number {
  const { radius, centre, edge } = blast;
  const along = Math.min(1, Math.max(0, distance / radius));
  return centre + (edge - centre) * along;
}

/** How a burst shows itself and what else it does. */
interface Detonation {
  /** Its bang, heard, and making a noise, out to its range. */
  readonly sound: Sound;
  /** Whether it knocks down the walls it reaches. */
  readonly walls: boolean;
}

/**
 * Sets `blast` off where `source` stands, as the host: sounds and shows the burst on every client,
 * knocks down the walls it reaches if it does, and hurts every body it reaches, players and world
 * entities alike, but `source` itself and items lying about, by how near it is, down to `source`.
 */
export function detonate(
  game: Session,
  source: WorldEntity,
  blast: Blast,
  made: Detonation,
): void {
  const { radius } = blast;
  const at = { x: source.x, y: source.y };
  if (made.walls) destroyWalls(game, { center: at, radius });
  effect(
    game,
    { at: source, sound: made.sound, flash: { radius, hit: true } },
    source,
  );
  const reach = (body: { readonly radius: number }) => radius + body.radius;
  for (const body of preyNear(game, source, reach, [])) {
    const distance = Math.hypot(body.x - at.x, body.y - at.y);
    const caught = bodyById(game, body.id);
    if (caught !== null)
      hurt(game, caught, blastDamage(distance, blast), source.id);
  }
}

/**
 * A burst in the shape of a plus, as in Bomberman: an arm out each of the four ways from the cell
 * it goes off in, along the grid. Any kind that goes off this way, a bomb as a rule, declares one.
 */
export interface CrossBlast {
  /** Cells each arm reaches past the one it goes off in, when no wall stops it first. */
  readonly reach: number;
  /**
   * Walls each arm knocks down: it carries on through each it breaks, and stops at the last of
   * them, that cell now open floor. The map's edge stops it, unbroken.
   */
  readonly walls: number;
  /** Damage it deals to each body its arms or middle touch, wherever in them it stands. */
  readonly damage: number;
}

/** A cell of the grid, column and row. */
type GridCell = readonly [col: number, row: number];

const ARMS: readonly GridCell[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The cells a plus burst from the cell at (`col`, `row`) of `map` reaches, the middle first, and
 * the wall cells among them it knocks down, row-major, as `cross` says; it changes nothing.
 */
export function crossCells(
  map: Pick<TileMap, "cols" | "rows" | "solid">,
  col: number,
  row: number,
  cross: Pick<CrossBlast, "reach" | "walls">,
): { cells: GridCell[]; walls: number[] } {
  const cells: GridCell[] = [[col, row]];
  const walls: number[] = [];
  for (const [dc, dr] of ARMS) {
    let broken = 0;
    for (let step = 1; step <= cross.reach; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) break;
      cells.push([c, r]);
      const index = r * map.cols + c;
      if (map.solid[index] !== 1) continue;
      walls.push(index);
      broken++;
      if (broken >= cross.walls) break;
    }
  }
  return { cells, walls };
}

/** Whether a body's circle overlaps the cell at (`col`, `row`) of side `cell`. */
function touchesCell(body: Prey, [col, row]: GridCell, cell: number): boolean {
  const nearX = Math.max(col * cell, Math.min(body.x, (col + 1) * cell));
  const nearY = Math.max(row * cell, Math.min(body.y, (row + 1) * cell));
  return Math.hypot(nearX - body.x, nearY - body.y) < body.radius;
}

/**
 * Sets a plus burst off where `source` stands, as the host: knocks down the walls its arms break
 * for every client, flashes every cell it reaches with `sound` heard from its middle, and hurts
 * every body its arms touch, players and world entities alike, `source` and items lying about
 * aside. A hurt sets off whatever goes off at one, as another bomb or a land mine, so they chain.
 */
export function detonateCross(
  game: Session,
  source: WorldEntity,
  cross: CrossBlast,
  sound: Sound,
): void {
  const { map } = game.world;
  const { cell } = map;
  const col = Math.floor(source.x / cell);
  const row = Math.floor(source.y / cell);
  const { cells, walls } = crossCells(map, col, row, cross);
  for (const index of walls) {
    const center = {
      x: ((index % map.cols) + 0.5) * cell,
      y: (Math.floor(index / map.cols) + 0.5) * cell,
    };
    destroyWalls(game, { center, radius: cell / 2, shape: "square" });
  }
  effect(game, { at: { x: source.x, y: source.y }, sound }, source);
  for (const [c, r] of cells)
    effect(
      game,
      {
        at: { x: (c + 0.5) * cell, y: (r + 0.5) * cell },
        flash: { radius: cell / 2, hit: true },
      },
      source,
    );
  const caught = preyNear(game, source, () => Infinity, []).filter((body) =>
    cells.some((at) => touchesCell(body, at, cell)),
  );
  for (const body of caught) {
    const hit = bodyById(game, body.id);
    if (hit !== null) hurt(game, hit, cross.damage, source.id);
  }
}
