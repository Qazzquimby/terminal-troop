/**
 * How remembered terrain fades: like ink soaking away rather than a lamp dimming. Each spot of it
 * has its own lifespan, drawn from smooth noise over the world, so blots of it go before others
 * and the edge between what is left and what is gone is ragged.
 */
export interface InkFadeConfig {
  /** Seconds after it was last seen that the last of remembered terrain is gone; 0 never fades. */
  readonly seconds: number;
  /** 0..1: how much sooner than `seconds` the first spots go, as a share of it. */
  readonly spread: number;
  /** Cells across a blot of the noise: about the size of the patches that go together. */
  readonly blot: number;
  /** Spots of noise along each side of a cell: more draws a finer ragged edge, at more cost. */
  readonly detail: number;
}

/** A whole-number hash of a lattice point, as 0..1. */
function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const ease = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise at (`x`, `y`), in lattice units, 0..1. */
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = ease(x - ix);
  const fy = ease(y - iy);
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * fx;
  const bottom =
    hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * The ink's noise at (`x`, `y`), in cells, 0 up to but not 1: blots `blot` cells across, their
 * edges roughened by a finer layer, stretched so the whole range is used.
 */
export function inkNoise(x: number, y: number, blot: number): number {
  const size = Math.max(0.5, blot);
  const coarse = valueNoise(x / size, y / size);
  const fine = valueNoise((x * 3) / size + 17.3, (y * 3) / size - 5.1);
  const mixed = coarse * 0.7 + fine * 0.3;
  return Math.min(0.999, Math.max(0, (mixed - 0.5) * 1.8 + 0.5));
}

/**
 * How much of remembered terrain is left, 0..1, `age` seconds after it was last seen, at a spot
 * whose noise is `noise`. It lasts `seconds` less `spread` of it by its noise, and darkens faster
 * the nearer it is to going: then it is gone at once, which leaves the ragged edge.
 */
export function inkLeft(
  age: number,
  noise: number,
  { seconds, spread }: Pick<InkFadeConfig, "seconds" | "spread">,
): number {
  if (seconds <= 0) return 1;
  const life = seconds * (1 - Math.min(1, Math.max(0, spread)) * noise);
  if (age >= life) return 0;
  const t = Math.max(0, age) / life;
  return 1 - t * t;
}

/** Remembered terrain's age at each cell of a box of the world: seconds since last seen. */
export interface AgeGrid {
  /** The box's top-left cell, and how many cells it spans. */
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major; Infinity where nothing is remembered. */
  readonly ages: Float32Array;
}

/**
 * How much ink is left over `grid`, `fade.detail` spots to a cell's side, as RGBA white with the
 * ink left as alpha: an image to keep remembered terrain within, drawn stretched over the box.
 */
export function inkMask(grid: AgeGrid, fade: InkFadeConfig): ImageDataLike {
  const detail = Math.max(1, Math.round(fade.detail));
  const width = grid.cols * detail;
  const height = grid.rows * detail;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const cellRow = Math.floor(y / detail);
    for (let x = 0; x < width; x++) {
      const cellCol = Math.floor(x / detail);
      const age = grid.ages[cellRow * grid.cols + cellCol] ?? Infinity;
      if (age === Infinity) continue;
      const noise = inkNoise(
        grid.col + (x + 0.5) / detail,
        grid.row + (y + 0.5) / detail,
        fade.blot,
      );
      const at = (y * width + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(inkLeft(age, noise, fade) * 255);
    }
  }
  return { width, height, data };
}

/** What an `ImageData` holds, made without a canvas. */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}
