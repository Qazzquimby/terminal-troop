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

/**
 * The cheapest 8-directional path from `from` to `to`, both ends included, where a straight
 * step costs 1 and a diagonal one √2. A diagonal step needs both cells beside it free, so no
 * path cuts a blocked corner. Null when either end is blocked or off the grid, or no path
 * joins them.
 */
export function findPath(grid: Grid, from: Cell, to: Cell): Cell[] | null {
  const { cols, rows, solid } = grid;
  const free = (col: number, row: number): boolean =>
    col >= 0 &&
    row >= 0 &&
    col < cols &&
    row < rows &&
    solid[row * cols + col] !== 1;
  if (!free(from.col, from.row) || !free(to.col, to.row)) return null;

  const start = from.row * cols + from.col;
  const goal = to.row * cols + to.col;
  const cost = new Float64Array(cols * rows).fill(Infinity);
  const parent = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const open = createHeap();
  cost[start] = 0;
  open.push(start, octile(to.col - from.col, to.row - from.row));

  for (let at = open.pop(); at !== undefined; at = open.pop()) {
    if (at === goal) return trace(parent, goal, cols);
    if (closed[at] === 1) continue;
    closed[at] = 1;
    const col = at % cols;
    const row = (at - col) / cols;
    const here = cost[at] ?? Infinity;
    for (const [dc, dr, step] of STEPS) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (!free(nextCol, nextRow)) continue;
      if (dc !== 0 && dr !== 0 && (!free(nextCol, row) || !free(col, nextRow)))
        continue;
      const next = nextRow * cols + nextCol;
      const through = here + step;
      if (closed[next] === 1 || through >= (cost[next] ?? Infinity)) continue;
      cost[next] = through;
      parent[next] = at;
      open.push(next, through + octile(to.col - nextCol, to.row - nextRow));
    }
  }
  return null;
}

function trace(parent: Int32Array, goal: number, cols: number): Cell[] {
  const path: Cell[] = [];
  for (let at = goal; at !== -1; at = parent[at] ?? -1) {
    path.push({ col: at % cols, row: Math.floor(at / cols) });
  }
  return path.reverse();
}
