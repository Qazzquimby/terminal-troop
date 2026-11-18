import type { Point } from "./map.js";

/*
 * A uniform grid over points, so a rule asking what lies near somewhere looks at the few cells
 * round it rather than at everything (#470). It only narrows: what it returns is every point that
 * may lie within the range asked, and the caller still measures each. Points are numbered by
 * their place in the list the grid was built from, and come back in that order, so a rule that
 * went over the whole list in order goes over the near ones in the same order.
 *
 * A point that moves keeps its old cell until `moved` is told. A point that is not finite, which
 * could be anywhere, is near everything, and a range or place that is not finite reaches
 * everything.
 */

/** A cell's key from its column and row. Two cells sharing a key only widen what is returned. */
const keyOf = (col: number, row: number): number => col * 94_906_249 + row;

export class SpatialGrid<T extends Point> {
  private readonly cells = new Map<number, number[]>();
  /** Each point's cell key; null for one that is not finite. */
  private readonly keys: (number | null)[] = [];
  /** The points that are not finite, near every place. */
  private readonly anywhere = new Set<number>();

  constructor(
    readonly items: readonly T[],
    readonly cell: number,
  ) {
    if (!(cell > 0) || !Number.isFinite(cell))
      throw new Error(`Bad grid cell size: ${String(cell)}`);
    items.forEach((item, index) => {
      this.keys.push(null);
      this.place(index, item);
    });
  }

  private place(index: number, at: Point): void {
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      this.keys[index] = null;
      this.anywhere.add(index);
      return;
    }
    const key = keyOf(
      Math.floor(at.x / this.cell),
      Math.floor(at.y / this.cell),
    );
    this.keys[index] = key;
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [index]);
    else bucket.push(index);
  }

  /** Puts the point numbered `index` in the cell where it now stands. */
  moved(index: number): void {
    const item = this.items[index];
    if (item === undefined) return;
    const old = this.keys[index] ?? null;
    if (old === null) this.anywhere.delete(index);
    else {
      const finite = Number.isFinite(item.x) && Number.isFinite(item.y);
      if (
        finite &&
        keyOf(
          Math.floor(item.x / this.cell),
          Math.floor(item.y / this.cell),
        ) === old
      )
        return;
      const bucket = this.cells.get(old);
      if (bucket !== undefined) {
        bucket.splice(bucket.indexOf(index), 1);
        if (bucket.length === 0) this.cells.delete(old);
      }
    }
    this.place(index, item);
  }

  /**
   * The number of every point that may lie within `range` of `at`, edges included, in the order
   * of the list: all of them for a place or range that is not finite.
   */
  near(at: Point, range: number): number[] {
    if (
      !Number.isFinite(at.x) ||
      !Number.isFinite(at.y) ||
      !Number.isFinite(range)
    )
      return this.items.map((_, index) => index);
    const found: number[] = [...this.anywhere];
    // A hair wider, so rounding at a cell's edge never leaves out a point right at the range.
    const reach = Math.max(0, range) + this.cell * 1e-6;
    const minCol = Math.floor((at.x - reach) / this.cell);
    const maxCol = Math.floor((at.x + reach) / this.cell);
    const minRow = Math.floor((at.y - reach) / this.cell);
    const maxRow = Math.floor((at.y + reach) / this.cell);
    // A range wider than the points are many: looking at each cell would cost more than all.
    if ((maxCol - minCol + 1) * (maxRow - minRow + 1) > this.items.length)
      return this.items.map((_, index) => index);
    for (let col = minCol; col <= maxCol; col++)
      for (let row = minRow; row <= maxRow; row++) {
        const bucket = this.cells.get(keyOf(col, row));
        if (bucket !== undefined) for (const index of bucket) found.push(index);
      }
    found.sort((a, b) => a - b);
    // Far-off cells can share a key, and so a bucket: each point once.
    return found.filter((index, place) => index !== found[place - 1]);
  }
}
