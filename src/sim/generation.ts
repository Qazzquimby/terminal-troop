import { minBy, range, sumBy } from "lodash-es";
import type {
  DangerConfig,
  Layout,
  Rect,
  Rng,
  World,
  WorldConfig,
} from "./map.js";
import { AREA } from "./map.js";
import { lightRooms } from "./light.js";
import type { RoomLightConfig, UnlitRoom } from "./light.js";

/** A whole-number span, both ends included. */
interface Span {
  readonly min: number;
  readonly max: number;
}

/**
 * How the standard world is laid out. A road runs the width of the world from the start, at its
 * left end, to the exit, at its right. Open yards line it, cluttered more thickly away from it.
 * Past the yards to the edge of the world are buildings: mostly wall, with rooms and hallways
 * joined by doors, and to the yards.
 */
export interface GenerationConfig {
  readonly road: {
    /** Its width, in cells, drawn afresh at each bend. */
    readonly width: Span;
    /** Columns between one bend and the next. */
    readonly step: number;
    /** Most rows its centre moves from one bend to the next. */
    readonly meander: number;
    /** Least rows kept between its widest possible edge and the top or bottom of the world. */
    readonly margin: number;
  };
  readonly yard: {
    /** Cells of yard either side of the road, before the buildings, drawn afresh at each bend. */
    readonly depth: Span;
    /**
     * Chance a try places clutter, by the road (`near`) and at the yard's far edge (`far`),
     * eased between. Clutter keeps a cell clear round it, so it never seals a way through.
     */
    readonly clutter: { readonly near: number; readonly far: number };
    /** Tries at clutter for each yard cell. */
    readonly tries: number;
  };
  readonly rooms: {
    /** A room's sides, in cells, walls not counted. */
    readonly size: Span;
    /** Fewest floor cells a room keeps where the yard cuts into it; a smaller scrap is walled up. */
    readonly minCells: number;
    /** Chance a box that is not a hallway is left solid wall, so buildings are more wall than floor. */
    readonly solidChance: number;
    /** Chance each cut of a building lays a hallway along it instead of halving it. */
    readonly hallwayChance: number;
    /** A hallway's width, and the longest it runs before a wall breaks it, in cells. */
    readonly hallway: { readonly width: number; readonly length: number };
    /** A door's width, in cells. */
    readonly door: Span;
    /**
     * Chance each way between two rooms of a building, beyond the fewest that join all its rooms
     * up, gets a door too, closing a loop. Low, so a building is mostly a tree of rooms with
     * chokepoints, and now and then a second way round.
     */
    readonly loops: number;
    /**
     * How many rooms a building is grown to: a group of rooms sharing walls, doors between them
     * inside, cut off from the buildings next door by walls but for its doors out. Fewer where it
     * runs out of rooms; more where a building shut in has to become part of its neighbour.
     */
    readonly building: Span;
    /**
     * Chance a building has 1, 2, 3, ... doors out, to outdoors or to a building next door, by
     * index, as weights. Fewer where it has no more ways out.
     */
    readonly exits: readonly number[];
  };
  /** Which rooms have light fixtures, and which have the power to light them. */
  readonly lights: RoomLightConfig;
  /** How dangerous places are, by how far they are from the road and across the world. */
  readonly danger: DangerConfig;
  /** Columns at the left end of the road that are the start. */
  readonly start: number;
  /** Columns at the right end of the road that are the exit. */
  readonly exit: number;
}

type Cell = readonly [col: number, row: number];

/** Least free cells between two pieces of clutter, or clutter and a wall. */
const GAP = 1;

// Clutter shapes as [col, row] cells. Must not contain holes
// prettier-ignore
const SHAPES: readonly (readonly Cell[])[] = [
  [[0, 0]], // 1x1
  [[0, 0], [1, 0]], // 1x2
  [[0, 0], [1, 0], [2, 0]], // 1x3
  [[0, 0], [1, 0], [2, 0], [3, 0]], // 1x4
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], // 1x5
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], // 1x6

  [[0, 0], [1, 0], [0, 1], [1, 1]], // 2x2
  [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]], // 2x3 C

  [[0, 0], [0, 1], [1, 1], [2, 1]], // 2x2 L
  [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], // 2x3 L

  [[0, 0], [1, 0], [2, 0], [1, 1]], // 2x2 T
  [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]], // 2x3 T

  [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]], // 2x3 zigzag
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], // plus
];

function pick<T>(items: readonly T[], rng: Rng): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined)
    throw new RangeError("Cannot pick from an empty list.");
  return item;
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

/** A whole number drawn evenly from `span`. */
function within(span: Span, rng: Rng): number {
  return span.min + Math.floor(rng() * (span.max - span.min + 1));
}

/** Rotates a quarter turn `times` times. */
function rotate(cells: Cell[], times: number): Cell[] {
  return times <= 0
    ? cells
    : rotate(
        cells.map(([c, r]): Cell => [-r, c]),
        times - 1,
      );
}

function transform(
  shape: readonly Cell[],
  rot: number,
  mirror: boolean,
): Cell[] {
  const cells = rotate(
    shape.map(([c, r]): Cell => [mirror ? -c : c, r]),
    rot,
  );
  const minC = Math.min(...cells.map((p) => p[0]));
  const minR = Math.min(...cells.map((p) => p[1]));
  return cells.map(([c, r]) => [c - minC, r - minR]);
}

/** The cells being laid out, row-major. */
interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly solid: Uint8Array;
  readonly area: Uint8Array;
  readonly room: Int16Array;
}

/**
 * A value for each column that eases between values drawn at every `step` columns, each draw
 * given the one before it.
 */
function profile(
  cols: number,
  step: number,
  draw: (previous: number | undefined) => number,
): Float64Array {
  const bends: number[] = [];
  for (let i = 0; i <= Math.ceil((cols - 1) / step); i++)
    bends.push(draw(bends.at(-1)));
  return Float64Array.from(range(cols), (col) => {
    const i = Math.floor(col / step);
    const from = bends[i] ?? 0;
    const to = bends[i + 1] ?? from;
    const t = (col - i * step) / step;
    return from + (to - from) * t * t * (3 - 2 * t);
  });
}

/** Each column's road, its first and last rows. */
interface RoadSpan {
  readonly top: number;
  readonly bottom: number;
}

function layRoad(
  grid: Grid,
  config: GenerationConfig["road"],
  rng: Rng,
): RoadSpan[] {
  const { cols, rows } = grid;
  const half = config.width.max / 2;
  const low = Math.min(rows / 2, config.margin + half);
  const high = Math.max(rows / 2, rows - config.margin - half);
  const widths = profile(cols, config.step, () => within(config.width, rng));
  const centres = profile(cols, config.step, (previous) => {
    const from = previous ?? low + rng() * (high - low);
    const to = from + (rng() * 2 - 1) * config.meander;
    return Math.min(high, Math.max(low, to));
  });
  return range(cols).map((col) => {
    const width = Math.round(widths[col] ?? config.width.min);
    const centre = centres[col] ?? rows / 2;
    const top = Math.max(0, Math.round(centre - width / 2));
    const bottom = Math.min(rows - 1, top + width - 1);
    for (let row = top; row <= bottom; row++)
      grid.area[row * cols + col] = AREA.road;
    return { top, bottom };
  });
}

/** The cells round cell `i`, diagonals included, that are in the world. */
function around(grid: Grid, i: number): number[] {
  const col = i % grid.cols;
  const row = (i / grid.cols) | 0;
  const found: number[] = [];
  for (let r = Math.max(0, row - 1); r <= Math.min(grid.rows - 1, row + 1); r++)
    for (
      let c = Math.max(0, col - 1);
      c <= Math.min(grid.cols - 1, col + 1);
      c++
    )
      if (c !== col || r !== row) found.push(r * grid.cols + c);
  return found;
}

/** Each cell's distance from the nearest road cell, diagonals counting one. */
function roadDistances(grid: Grid): Uint16Array {
  const { cols, rows, area } = grid;
  const distance = new Uint16Array(cols * rows).fill(0xffff);
  let frontier: number[] = [];
  area.forEach((code, i) => {
    if (code !== AREA.road) return;
    distance[i] = 0;
    frontier.push(i);
  });
  for (let d = 1; frontier.length > 0; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      for (const n of around(grid, i)) {
        if ((distance[n] ?? 0) <= d) continue;
        distance[n] = d;
        next.push(n);
      }
    }
    frontier = next;
  }
  return distance;
}

/** A box of cells a building is cut into; a hallway if cut off as one. */
interface Leaf {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  readonly hallway: boolean;
}

/**
 * Cuts the whole world into boxes no larger than a room, each cut a line of wall cells marked in
 * `walls`. Some cuts lay a hallway beside them instead of halving the box.
 */
function partition(
  grid: Grid,
  config: GenerationConfig["rooms"],
  rng: Rng,
  walls: Uint8Array,
): Leaf[] {
  const { size, hallway } = config;
  const leaves: Leaf[] = [];
  const pending: Leaf[] = [
    { col: 0, row: 0, cols: grid.cols, rows: grid.rows, hallway: false },
  ];
  for (let box = pending.pop(); box !== undefined; box = pending.pop()) {
    const longest = Math.max(box.cols, box.rows);
    const across = box.cols >= box.rows;
    const limit = box.hallway ? hallway.length : size.max;
    const tooBig = box.hallway
      ? longest > limit
      : box.cols > limit || box.rows > limit;
    if (!tooBig || longest < size.min * 2 + 1) {
      leaves.push(box);
      continue;
    }
    // Cut across the longer side.
    let at: number;
    let strip: "before" | "after" | null = null;
    if (
      !box.hallway &&
      rng() < config.hallwayChance &&
      longest >= hallway.width + 1 + size.min
    ) {
      strip = rng() < 0.5 ? "before" : "after";
      at = strip === "before" ? hallway.width : longest - hallway.width - 1;
    } else {
      at = size.min + Math.floor(rng() * (longest - size.min * 2));
    }
    const first = {
      ...box,
      ...(across ? { cols: at } : { rows: at }),
      hallway: box.hallway || strip === "before",
    };
    const second = {
      ...box,
      ...(across
        ? { col: box.col + at + 1, cols: box.cols - at - 1 }
        : { row: box.row + at + 1, rows: box.rows - at - 1 }),
      hallway: box.hallway || strip === "after",
    };
    for (let k = 0; k < (across ? box.rows : box.cols); k++) {
      const col = across ? box.col + at : box.col + k;
      const row = across ? box.row + k : box.row + at;
      walls[row * grid.cols + col] = 1;
    }
    pending.push(first, second);
  }
  return leaves;
}

/** Whether cell `i` borders, diagonals included, a cell that is not `building`. */
function onFacade(grid: Grid, building: Uint8Array, i: number): boolean {
  return around(grid, i).some((n) => building[n] !== 1);
}

/** The cells 4-connected to `start` that `inside` accepts, `start` included. */
function flood(
  grid: Grid,
  start: number,
  inside: (i: number) => boolean,
  seen: Uint8Array,
): number[] {
  const found: number[] = [];
  const stack = [start];
  seen[start] = 1;
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    found.push(i);
    const col = i % grid.cols;
    const next = [
      col > 0 ? i - 1 : -1,
      col < grid.cols - 1 ? i + 1 : -1,
      i - grid.cols,
      i + grid.cols,
    ];
    for (const n of next) {
      if (n < 0 || n >= grid.solid.length || seen[n] === 1 || !inside(n))
        continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return found;
}

/** A room as it is carved, before rooms walled up later are dropped. */
interface Carved {
  readonly cells: number[];
  readonly hallway: boolean;
}

/**
 * Carves the rooms out of the buildings' mass: each box's floor, less its walls and the building's
 * outer wall where the yard cuts into it. A piece of a box too small to be a room stays wall.
 */
function carveRooms(
  grid: Grid,
  config: GenerationConfig["rooms"],
  rng: Rng,
  building: Uint8Array,
): Carved[] {
  const walls = new Uint8Array(grid.solid.length);
  const leaves = partition(grid, config, rng, walls);
  const floor = new Uint8Array(grid.solid.length);
  building.forEach((value, i) => {
    if (value === 1 && walls[i] !== 1 && !onFacade(grid, building, i))
      floor[i] = 1;
  });
  const rooms: Carved[] = [];
  const seen = new Uint8Array(grid.solid.length);
  for (const leaf of leaves) {
    if (!leaf.hallway && rng() < config.solidChance) continue;
    const inLeaf = (i: number): boolean => {
      const col = i % grid.cols;
      const row = (i / grid.cols) | 0;
      return (
        floor[i] === 1 &&
        col >= leaf.col &&
        col < leaf.col + leaf.cols &&
        row >= leaf.row &&
        row < leaf.row + leaf.rows
      );
    };
    for (let row = leaf.row; row < leaf.row + leaf.rows; row++) {
      for (let col = leaf.col; col < leaf.col + leaf.cols; col++) {
        const start = row * grid.cols + col;
        if (seen[start] === 1 || !inLeaf(start)) continue;
        const cells = flood(grid, start, inLeaf, seen);
        if (cells.length < config.minCells) continue;
        const id = rooms.length;
        for (const i of cells) {
          grid.solid[i] = 0;
          grid.area[i] = AREA.room;
          grid.room[i] = id;
        }
        rooms.push({ cells, hallway: leaf.hallway });
      }
    }
  }
  return rooms;
}

/** True when no cell within GAP of (c, r) is solid. Caller keeps (c, r) GAP from the edge. */
function neighbourhoodClear(grid: Grid, c: number, r: number): boolean {
  for (let rr = r - GAP; rr <= r + GAP; rr++)
    for (let cc = c - GAP; cc <= c + GAP; cc++)
      if (grid.solid[rr * grid.cols + cc] === 1) return false;
  return true;
}

function canPlace(
  grid: Grid,
  cells: readonly Cell[],
  ox: number,
  oy: number,
): boolean {
  return cells.every(([dc, dr]) => {
    const c = ox + dc;
    const r = oy + dr;
    const inBounds =
      c >= GAP && r >= GAP && c < grid.cols - GAP && r < grid.rows - GAP;
    return (
      inBounds &&
      grid.area[r * grid.cols + c] === AREA.yard &&
      neighbourhoodClear(grid, c, r)
    );
  });
}

/**
 * Scatters clutter over the yards, thicker away from the road. Every piece keeps a free cell
 * round it, so the yards stay open to walk through.
 */
function clutterYards(
  grid: Grid,
  config: GenerationConfig["yard"],
  depths: Float64Array,
  distance: Uint16Array,
  rng: Rng,
): void {
  const yard = range(grid.solid.length).filter(
    (i) => grid.area[i] === AREA.yard,
  );
  if (yard.length === 0) return;
  const tries = Math.round(yard.length * config.tries);
  for (let attempt = 0; attempt < tries; attempt++) {
    const i = pick(yard, rng);
    const depth = Math.max(1, depths[i % grid.cols] ?? 1);
    const t = Math.min(1, Math.max(0, ((distance[i] ?? 1) - 1) / depth));
    const chance =
      config.clutter.near + (config.clutter.far - config.clutter.near) * t;
    if (rng() >= chance) continue;
    const cells = transform(
      pick(SHAPES, rng),
      Math.floor(rng() * 4),
      rng() < 0.5,
    );
    const ox = i % grid.cols;
    const oy = (i / grid.cols) | 0;
    if (!canPlace(grid, cells, ox, oy)) continue;
    for (const [dc, dr] of cells) {
      const n = (oy + dr) * grid.cols + (ox + dc);
      grid.solid[n] = 1;
      grid.area[n] = AREA.wall;
    }
  }
}

/** Which side of a door each cell of the wall it cuts lies on: a room's id plus one, 0 outdoors. */
function sideOf(grid: Grid, i: number): number {
  const area = grid.area[i];
  if (area === AREA.room) return (grid.room[i] ?? -1) + 1;
  if (area === AREA.road || area === AREA.yard) return 0;
  return -1;
}

/** A wall cell a door may be cut through, and the step along the wall from it. */
interface DoorSpot {
  readonly cell: number;
  readonly along: number;
}

/** A way two places could be joined: a room's id plus one, or 0 for outdoors; and where. */
interface Way {
  readonly a: number;
  readonly b: number;
  readonly spots: DoorSpot[];
}

/** Every wall cell with a different room, or a room and outdoors, either side of it. */
function waysThrough(grid: Grid): Way[] {
  const { cols, rows } = grid;
  const ways = new Map<string, Way>();
  const offer = (
    cell: number,
    before: number,
    after: number,
    along: number,
  ): void => {
    const a = sideOf(grid, before);
    const b = sideOf(grid, after);
    if (a < 0 || b < 0 || a === b) return;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = `${String(low)},${String(high)}`;
    const way = ways.get(key) ?? { a: low, b: high, spots: [] };
    ways.set(key, way);
    way.spots.push({ cell, along });
  };
  grid.area.forEach((code, i) => {
    if (code !== AREA.wall) return;
    const col = i % cols;
    const row = (i / cols) | 0;
    if (col > 0 && col < cols - 1) offer(i, i - 1, i + 1, cols);
    if (row > 0 && row < rows - 1) offer(i, i - cols, i + cols, 1);
  });
  return [...ways.values()];
}

/** Union-find over `count` places. */
function unions(count: number) {
  const parent = Int32Array.from(range(count));
  const root = (i: number): number => {
    let at = i;
    while (parent[at] !== at) at = parent[at] ?? at;
    parent[i] = at;
    return at;
  };
  return {
    root,
    join(a: number, b: number): boolean {
      const ra = root(a);
      const rb = root(b);
      if (ra === rb) return false;
      parent[ra] = rb;
      return true;
    },
  };
}

/** Cuts a door up to `width` cells wide, as far as the wall allows, at a random spot along `way`. */
function cutDoor(grid: Grid, way: Way, width: number, rng: Rng): void {
  // A door kept off the ends of other doors, so two never run together into one too wide.
  const isDoor = (cell: number) => grid.area[cell] === AREA.door;
  const apart = ({ cell, along }: DoorSpot) =>
    !isDoor(cell - along) && !isDoor(cell + along);
  const open = way.spots.filter(apart);
  const spot = pick(open.length > 0 ? open : way.spots, rng);
  const line = new Set(
    open
      .filter((other) => other.along === spot.along)
      .map((other) => other.cell),
  );
  const cells = [spot.cell];
  for (
    let next = spot.cell + spot.along;
    cells.length < width && line.has(next);
    next += spot.along
  )
    cells.push(next);
  for (
    let next = spot.cell - spot.along;
    cells.length < width && line.has(next);
    next -= spot.along
  )
    cells.push(next);
  for (const cell of cells) {
    grid.solid[cell] = 0;
    grid.area[cell] = AREA.door;
  }
}

/** An index into `weights`, drawn in proportion to its weight. */
function weighted(weights: readonly number[], rng: Rng): number {
  const total = sumBy(weights, (weight) => Math.max(0, weight));
  let left = rng() * total;
  for (const [i, weight] of weights.entries()) {
    left -= Math.max(0, weight);
    if (left < 0) return i;
  }
  return Math.max(0, weights.length - 1);
}

/**
 * Groups the rooms, numbered from 1, into buildings, each grown from a room through the walls it
 * shares with others until it has as many rooms as drawn from `size`, or no more to take. Each
 * room's building is the number of the room it was grown from; index 0, outdoors, is 0.
 */
function groupBuildings(
  inside: readonly Way[],
  count: number,
  size: Span,
  rng: Rng,
): Int32Array {
  const neighbours = new Map<number, number[]>();
  for (const { a, b } of inside) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const building = new Int32Array(count + 1);
  for (const seed of shuffle(range(1, count + 1), rng)) {
    if (building[seed] !== 0) continue;
    const target = within(size, rng);
    building[seed] = seed;
    let members = 1;
    const frontier = [seed];
    while (frontier.length > 0 && members < target) {
      const at = frontier.splice(Math.floor(rng() * frontier.length), 1)[0];
      for (const next of neighbours.get(at ?? 0) ?? []) {
        if (members >= target) break;
        if (building[next] !== 0) continue;
        building[next] = seed;
        members++;
        frontier.push(next);
      }
    }
  }
  // A building left smaller than `size` allows, hemmed in by others, joins its smallest neighbour.
  const members = new Map<number, number[]>();
  for (let place = 1; place <= count; place++) {
    const id = building[place] ?? 0;
    members.set(id, [...(members.get(id) ?? []), place]);
  }
  for (const [id, rooms] of members) {
    if (rooms.length >= size.min) continue;
    const others = rooms
      .flatMap((place) => neighbours.get(place) ?? [])
      .map((place) => building[place] ?? 0)
      .filter((other) => other !== id);
    const smallest = minBy(others, (other) => members.get(other)?.length ?? 0);
    if (smallest === undefined) continue;
    const into = members.get(smallest) ?? [];
    for (const place of rooms) building[place] = smallest;
    into.push(...rooms);
    rooms.length = 0;
  }
  return building;
}

/**
 * Cuts the doors. The rooms are grouped into buildings (see `groupBuildings`); each building's
 * rooms are joined by the fewest doors between them, and by chance a few more so some ways loop.
 * Each building draws how many doors out it has, to outdoors or to a building next door. First
 * each gets one outdoors where it can; then each still shut in gets one to a building already
 * joined up, or, where that building has no doors out to spare, becomes part of it. Last, each
 * building is given its other doors out where it has ways to put them. A building with no way out
 * at all is walled up later. Returns each room's building, numbered from 1 as rooms are.
 */
function cutDoors(
  grid: Grid,
  config: GenerationConfig["rooms"],
  count: number,
  rng: Rng,
): Int32Array {
  const ways = shuffle(waysThrough(grid), rng);
  const grown = groupBuildings(
    ways.filter((way) => way.a > 0),
    count,
    config.building,
    rng,
  );
  const merged = unions(count + 1);
  const of = (place: number): number => merged.root(grown[place] ?? 0);
  const inner = (way: Way): boolean => way.a > 0 && of(way.a) === of(way.b);
  const chosen = new Set<Way>();

  const tree = unions(count + 1);
  for (const way of ways)
    if (inner(way) && tree.join(way.a, way.b)) chosen.add(way);

  const budget = new Map<number, number>();
  const used = new Map<number, number>();
  for (let place = 1; place <= count; place++)
    if (grown[place] === place)
      budget.set(place, weighted(config.exits, rng) + 1);
  const spare = (building: number): boolean =>
    building === 0 || (used.get(building) ?? 0) < (budget.get(building) ?? 0);
  const out = unions(count + 1);
  const free = (building: number): boolean =>
    out.root(building) !== out.root(0);
  const link = (way: Way): void => {
    chosen.add(way);
    for (const building of [of(way.a), of(way.b)])
      used.set(building, (used.get(building) ?? 0) + 1);
    out.join(of(way.a), of(way.b));
  };
  const outer = (way: Way): boolean => !chosen.has(way) && !inner(way);

  for (const way of ways)
    if (way.a === 0 && free(of(way.b)) && spare(of(way.b))) link(way);
  // A way from a building shut in to one joined up.
  const reaching = (way: Way): boolean =>
    outer(way) && free(of(way.a)) !== free(of(way.b));
  for (;;) {
    let linked = false;
    for (const way of ways) {
      if (!reaching(way) || !spare(of(way.a)) || !spare(of(way.b))) continue;
      link(way);
      linked = true;
    }
    if (linked) continue;
    // None left with a door to spare: the pair that makes the smallest building becomes one.
    const size = (building: number): number =>
      range(1, count + 1).filter((place) => of(place) === building).length;
    const way = minBy(
      ways.filter(reaching),
      (each) => size(of(each.a)) + size(of(each.b)),
    );
    if (way === undefined) break;
    const [x, y] = [of(way.a), of(way.b)];
    const [shut, open] = free(x) ? [x, y] : [y, x];
    merged.join(shut, open);
    out.join(shut, open);
    chosen.add(way);
  }
  for (const way of ways) {
    if (!outer(way)) continue;
    if (spare(of(way.a)) && spare(of(way.b))) link(way);
  }

  for (const way of ways)
    if (inner(way) && !chosen.has(way) && rng() < config.loops) chosen.add(way);
  for (const way of chosen) cutDoor(grid, way, within(config.door, rng), rng);
  return Int32Array.from(range(count + 1), of);
}

/** Walls up every open cell `start` cannot reach, so nothing spawns sealed off. */
function sealUnreached(grid: Grid, start: number): void {
  const seen = new Uint8Array(grid.solid.length);
  flood(grid, start, (i) => grid.solid[i] !== 1, seen);
  grid.solid.forEach((value, i) => {
    if (value === 1 || seen[i] === 1) return;
    grid.solid[i] = 1;
    grid.area[i] = AREA.wall;
    grid.room[i] = -1;
  });
}

/**
 * The rooms as finally laid out, numbered afresh past any walled up, `grid.room` renumbered, and
 * their buildings numbered afresh from 0. `buildings` holds each carved room's building at its
 * index plus one.
 */
function finishRooms(
  grid: Grid,
  carved: readonly Carved[],
  buildings: Int32Array,
): UnlitRoom[] {
  const rooms: UnlitRoom[] = [];
  const renumbered = new Map<number, number>();
  carved.forEach((room, index) => {
    const cells = room.cells.filter((i) => grid.room[i] !== -1);
    if (cells.length === 0) return;
    const id = rooms.length;
    const cols = cells.map((i) => i % grid.cols);
    const rows = cells.map((i) => (i / grid.cols) | 0);
    const col = Math.min(...cols);
    const row = Math.min(...rows);
    for (const i of cells) grid.room[i] = id;
    const grown = buildings[index + 1] ?? 0;
    const building = renumbered.get(grown) ?? renumbered.size;
    renumbered.set(grown, building);
    rooms.push({
      building,
      id,
      col,
      row,
      cols: Math.max(...cols) - col + 1,
      rows: Math.max(...rows) - row + 1,
      cells: cells.length,
      hallway: room.hallway,
    });
  });
  return rooms;
}

/** The box, in pixels, over the road's cells in columns `from` up to `to`. */
function roadBox(
  road: readonly RoadSpan[],
  from: number,
  to: number,
  cell: number,
): Rect {
  const spans = road.slice(from, to);
  const top = Math.min(...spans.map((span) => span.top));
  const bottom = Math.max(...spans.map((span) => span.bottom));
  return {
    x: from * cell,
    y: top * cell,
    w: (to - from) * cell,
    h: (bottom - top + 1) * cell,
  };
}

/** The standard world at `config`'s size; `rng` lays it out. */
export function buildWorld(config: WorldConfig, rng: Rng): World {
  const { cols, rows, cell, generation } = config;
  const grid: Grid = {
    cols,
    rows,
    solid: new Uint8Array(cols * rows),
    area: new Uint8Array(cols * rows).fill(AREA.wall),
    room: new Int16Array(cols * rows).fill(-1),
  };
  const road = layRoad(grid, generation.road, rng);
  const distance = roadDistances(grid);
  const depths = profile(cols, generation.road.step, () =>
    within(generation.yard.depth, rng),
  );
  const building = new Uint8Array(cols * rows);
  distance.forEach((d, i) => {
    if (d === 0) return;
    if (d <= (depths[i % cols] ?? 0)) {
      grid.area[i] = AREA.yard;
      return;
    }
    building[i] = 1;
    grid.solid[i] = 1;
  });
  const carved = carveRooms(grid, generation.rooms, rng, building);
  clutterYards(grid, generation.yard, depths, distance, rng);
  const buildings = cutDoors(grid, generation.rooms, carved.length, rng);
  const middle = road[Math.floor(cols / 2)] ?? { top: 0, bottom: 0 };
  sealUnreached(
    grid,
    Math.floor((middle.top + middle.bottom) / 2) * cols + Math.floor(cols / 2),
  );
  const rooms = lightRooms(
    finishRooms(grid, carved, buildings),
    generation.lights,
    rng,
  );
  let farthest = 0;
  distance.forEach((d, i) => {
    if (grid.solid[i] !== 1) farthest = Math.max(farthest, d);
  });
  const start = Math.max(1, Math.min(cols, generation.start));
  const exit = Math.max(1, Math.min(cols, generation.exit));
  const layout: Layout = {
    area: grid.area,
    room: grid.room,
    rooms,
    roadDistance: distance,
    farthest,
    start: roadBox(road, 0, start, cell),
    exit: roadBox(road, cols - exit, cols, cell),
    danger: generation.danger,
    roadCentre: Float32Array.from(
      road,
      (span) => (span.top + span.bottom + 1) / 2,
    ),
    exitShade: generation.lights.exitShade,
  };
  return {
    W: cols * cell,
    H: rows * cell,
    map: { cell, cols, rows, solid: grid.solid },
    layout,
  };
}
