/** Square cells, row-major; a cell whose entry is 1 is blocked. */
export interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly solid: Uint8Array;
}

export interface Cell {
  readonly col: number;
  readonly row: number;
}

const STEPS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

/** The cost of the cheapest 8-directional walk across `dc` columns and `dr` rows on open ground. */
function octile(dc: number, dr: number): number {
  const a = Math.abs(dc);
  const b = Math.abs(dr);
  return Math.max(a, b) + (Math.SQRT2 - 1) * Math.min(a, b);
}

/** A binary min-heap of items by key. */
function createHeap() {
  const items: number[] = [];
  const keys: number[] = [];

  function swap(i: number, j: number): void {
    const item = items[i] ?? 0;
    const key = keys[i] ?? 0;
    items[i] = items[j] ?? 0;
    keys[i] = keys[j] ?? 0;
    items[j] = item;
    keys[j] = key;
  }

  const keyAt = (i: number): number => keys[i] ?? Infinity;

  return {
    push(item: number, key: number): void {
      items.push(item);
      keys.push(key);
      for (let i = items.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (keyAt(parent) <= keyAt(i)) break;
        swap(i, parent);
        i = parent;
      }
    },
    pop(): number | undefined {
      const top = items[0];
      const lastItem = items.pop();
      const lastKey = keys.pop();
      if (items.length === 0 || lastItem === undefined || lastKey === undefined)
        return top;
      items[0] = lastItem;
      keys[0] = lastKey;
      for (let i = 0; ;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let least = i;
        if (keyAt(left) < keyAt(least)) least = left;
        if (keyAt(right) < keyAt(least)) least = right;
        if (least === i) break;
        swap(i, least);
        i = least;
      }
      return top;
    },
  };
}

/** Whether `col`, `row` lies on `grid` and is not blocked. */
function passable(grid: Grid, col: number, row: number): boolean {
  return (
    col >= 0 &&
    row >= 0 &&
    col < grid.cols &&
    row < grid.rows &&
    grid.solid[row * grid.cols + col] !== 1
  );
}

/** How a search goes: where it may step, what it ends at, and how it reckons cost. */
interface Search {
  /** Whether a step may land on `col`, `row`. */
  readonly free: (col: number, row: number) => boolean;
  /** Whether the cell reached ends the search. */
  readonly done: (col: number, row: number) => boolean;
  /** A guess, never too high, of the cost left from `col`, `row`; 0 for none. */
  readonly estimate: (col: number, row: number) => number;
  readonly toll?: ((from: Cell, to: Cell) => number) | undefined;
}

/**
 * The cheapest 8-directional path from `from`, both ends included, to the first cell reached that
 * ends `search`, cells reached in order of cost plus estimate. Null for none.
 */
function search(grid: Grid, from: Cell, how: Search): Cell[] | null {
  const { cols, rows } = grid;
  const { free, done, estimate, toll } = how;
  const start = from.row * cols + from.col;
  const cost = new Float64Array(cols * rows).fill(Infinity);
  const parent = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const open = createHeap();
  cost[start] = 0;
  open.push(start, estimate(from.col, from.row));

  for (let at = open.pop(); at !== undefined; at = open.pop()) {
    if (closed[at] === 1) continue;
    closed[at] = 1;
    const col = at % cols;
    const row = (at - col) / cols;
    if (done(col, row)) return trace(parent, at, cols);
    const here = cost[at] ?? Infinity;
    for (const [dc, dr, step] of STEPS) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (!free(nextCol, nextRow)) continue;
      if (dc !== 0 && dr !== 0 && (!free(nextCol, row) || !free(col, nextRow)))
        continue;
      const next = nextRow * cols + nextCol;
      const paid =
        toll === undefined
          ? 0
          : toll({ col, row }, { col: nextCol, row: nextRow });
      const through = here + step + paid;
      if (closed[next] === 1 || through >= (cost[next] ?? Infinity)) continue;
      cost[next] = through;
      parent[next] = at;
      open.push(next, through + estimate(nextCol, nextRow));
    }
  }
  return null;
}

/**
 * The cheapest 8-directional path from `from` to `to`, both ends included, where a straight
 * step costs 1 and a diagonal one √2. A diagonal step needs both cells beside it free, so no
 * path cuts a blocked corner. A cell `avoid` names counts as blocked too, the two ends aside, so
 * a caller can keep a path off more than walls, such as lit ground. `toll`, when given, adds a
 * cost of 0 or more to each step from one cell to the next, such as the time it takes to break
 * through a wall on the way. Null when either end is blocked or off the grid, or no path joins
 * them.
 */
export function findPath(
  grid: Grid,
  from: Cell,
  to: Cell,
  avoid?: (cell: Cell) => boolean,
  toll?: (from: Cell, to: Cell) => number,
): Cell[] | null {
  if (!passable(grid, from.col, from.row) || !passable(grid, to.col, to.row))
    return null;
  const isEnd = (col: number, row: number): boolean =>
    (col === from.col && row === from.row) ||
    (col === to.col && row === to.row);
  return search(grid, from, {
    free: (col, row) =>
      passable(grid, col, row) &&
      (avoid === undefined || isEnd(col, row) || !avoid({ col, row })),
    done: (col, row) => col === to.col && row === to.row,
    estimate: (col, row) => octile(to.col - col, to.row - row),
    toll,
  });
}

/**
 * The cheapest 8-directional path from `from` to the nearest cell `wanted` names, by what walking
 * there costs, both ends included: just `from` when it is wanted itself. Steps cost as `findPath`
 * has them, and no step cuts a blocked corner. `wanted` is asked of each cell once at most, in
 * order of cost, so the search stops at the first. Null when `from` is blocked or off the grid,
 * or no wanted cell is reachable.
 */
export function findNearest(
  grid: Grid,
  from: Cell,
  wanted: (cell: Cell) => boolean,
): Cell[] | null {
  if (!passable(grid, from.col, from.row)) return null;
  return search(grid, from, {
    free: (col, row) => passable(grid, col, row),
    done: (col, row) => wanted({ col, row }),
    estimate: () => 0,
  });
}

function trace(parent: Int32Array, goal: number, cols: number): Cell[] {
  const path: Cell[] = [];
  for (let at = goal; at !== -1; at = parent[at] ?? -1) {
    path.push({ col: at % cols, row: Math.floor(at / cols) });
  }
  return path.reverse();
}
