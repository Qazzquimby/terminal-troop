import { mulberry32Next } from "./map.js";
import type { Session } from "./session.js";

/**
 * Deepdark: darkness deeper than night (#399). It is a property of a place, not of whoever is
 * there, so it bears on every body alike:
 * - no place's own light, sunlight or a fixture, lights any of it;
 * - a light reaches into it only `light` of its range, and a body's own sight, the little a
 *   player sees by in the dark and the eyes of every body, only `sight` of theirs;
 * - it is drawn wholly black, but for the eyes of what lurks in it, glowing now and then;
 * - remembered terrain in it fades `memoryFade` times as fast;
 * - things that show only in deepdark, such as dark scrap, show there and nowhere else.
 *
 * Deepdark lies where the deepdark front has passed and wherever darkness something gives off,
 * such as a gloom's, reaches (#401).
 *
 * Two fronts sweep a world from its left edge to its right on the world clock (#400): darkness,
 * behind which no sunlight falls, then deepdark. Each sets out from the left edge at its own
 * time and reaches the right edge at `fronts.end`. Neither edge is a straight line: each row of
 * the world is ahead or behind by smooth noise seeded by the world's seed, drifting on the world
 * clock (#494), so the same on the host and every client.
 */
export interface DeepdarkConfig {
  /** Share of its range a light reaches into deepdark. */
  readonly light: number;
  /** Share of its range a body's own sight reaches into deepdark. */
  readonly sight: number;
  /** How many times as fast remembered terrain in deepdark fades. */
  readonly memoryFade: number;
  /** How a body's eyes glow in deepdark, seen by those whose sight reaches it there. */
  readonly eyes: {
    /** Seconds between one body's glimpses, and how long each lasts. */
    readonly every: number;
    readonly for: number;
    readonly colour: string;
  };
  /** When, in sim seconds of world time, each front sets out from the left edge and arrives at the right. */
  readonly fronts: {
    readonly dark: number;
    readonly deep: number;
    readonly end: number;
  };
  /** How unevenly the fronts' edges run. */
  readonly ragged: RaggedConfig;
}

/**
 * How ragged a front's edge is: each row is ahead of or behind the front's mean by up to
 * `amplitude`, by smooth noise across rows that drifts as the world clock runs. The drift never
 * takes a row back from where the front had reached: it is slowed if need be so the front
 * outpaces it.
 */
export interface RaggedConfig {
  /** Most a row's edge is ahead of or behind the front's mean, in px. */
  readonly amplitude: number;
  /** Rows between the noise's coarsest bumps; each further octave halves it. */
  readonly scale: number;
  readonly octaves: number;
  /** Seconds the noise takes to drift from one shape to the next; 0 keeps one shape. */
  readonly drift: number;
}

/**
 * How far across the world, in pixels from its left edge, the mean edge of a front that sets out
 * at `start` and arrives at the right edge at `end`, ragged by up to `amplitude` either way, has
 * come by `time`: -Infinity before it sets out. The mean runs from `-amplitude` to
 * `width + amplitude`, so as it sets out no row is past the left edge, as it arrives every row is
 * past the right, and halfway it is halfway across.
 */
export function frontAt(
  width: number,
  start: number,
  end: number,
  time: number,
  amplitude = 0,
): number {
  if (time < start) return -Infinity;
  const progress =
    end <= start ? 1 : Math.min(1, (time - start) / (end - start));
  return progress * (width + 2 * amplitude) - amplitude;
}

/** Each front, as it sets out. */
type Front = "dark" | "deep";

/**
 * A front's edge in each row, in px from the world's left edge, as measured through the row's
 * centre; between centres it runs straight from one to the next. -Infinity before it sets out.
 */
type FrontEdge = ArrayLike<number>;

/**
 * Where each front's edge lies: no sunlight falls left of `dark`, and all left of `deep` is
 * deepdark, which no place's own light lights.
 */
export interface Fronts {
  readonly dark: FrontEdge;
  readonly deep: FrontEdge;
}

/** Fronts that have not set out: a world as it starts. */
export const NO_FRONTS: Fronts = { dark: [], deep: [] };

/** Where `edge` lies at height `y`, in a world of `cell`-px rows: -Infinity for no rows. */
export function edgeAt(edge: FrontEdge, cell: number, y: number): number {
  const last = edge.length - 1;
  if (last < 0) return -Infinity;
  const along = Math.min(last, Math.max(0, y / cell - 0.5));
  const row = Math.floor(along);
  const here = edge[row] ?? -Infinity;
  const next = edge[Math.min(last, row + 1)] ?? -Infinity;
  return here === next ? here : here + (next - here) * (along - row);
}

/** One [0, 1) value hashed from whole numbers. */
function hash(values: readonly number[]): number {
  let state = 0x811c9dc5;
  for (const value of values) state = Math.imul(state ^ value, 16777619);
  return mulberry32Next(state).value;
}

/**
 * Smooth value noise in -1..1 for each of `rows` rows: `octaves` layers of bumps, the first
 * `scale` rows apart and each next half as far apart and half as tall, drawn by `seed` and `key`.
 */
export function rowNoise(
  seed: number,
  key: number,
  rows: number,
  scale: number,
  octaves: number,
): Float64Array {
  const noise = new Float64Array(rows);
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const apart = Math.max(1, scale / 2 ** octave);
    const height = 0.5 ** octave;
    total += height;
    for (let row = 0; row < rows; row++) {
      const at = row / apart;
      const knot = Math.floor(at);
      const t = at - knot;
      const smooth = t * t * (3 - 2 * t);
      const a = hash([seed, key, octave, knot]);
      const b = hash([seed, key, octave, knot + 1]);
      noise[row] =
        (noise[row] ?? 0) + height * ((a + (b - a) * smooth) * 2 - 1);
    }
  }
  if (total > 0)
    for (let row = 0; row < rows; row++) noise[row] = (noise[row] ?? 0) / total;
  return noise;
}

/** Salts telling the two fronts' noise apart, so each has its own shape. */
const SALT: Readonly<Record<Front, number>> = { dark: 0xda7c, deep: 0xdee9 };

/**
 * Seconds `ragged`'s noise takes to drift from one shape to the next in a `width`-px world whose
 * fronts are as `fronts`: its own `drift`, or longer, so no row's edge drifts back faster than
 * the slowest front advances, and none ever goes back. 0 for one shape.
 */
export function driftPeriod(
  width: number,
  fronts: DeepdarkConfig["fronts"],
  ragged: RaggedConfig,
): number {
  if (ragged.drift <= 0) return 0;
  const longest = Math.max(
    0,
    ...(["dark", "deep"] as const)
      .map((front) => fronts.end - fronts[front])
      .filter((span) => Number.isFinite(span) && span > 0),
  );
  // A row's noise moves at most 2 (from -1 to 1) a period, its edge `amplitude` px for each 1.
  const across = width + 2 * ragged.amplitude;
  return Math.max(ragged.drift, (2 * ragged.amplitude * longest) / across);
}

/** Each session's noise shapes, by front and drift step, kept while they are wanted. */
const shapes = new WeakMap<Session, Map<string, Float64Array>>();

/** `game`'s noise for `front` at drift step `key`. */
function shape(game: Session, front: Front, key: number): Float64Array {
  let found = shapes.get(game);
  if (found === undefined) {
    found = new Map();
    shapes.set(game, found);
  }
  const name = `${front}:${String(key)}`;
  const known = found.get(name);
  if (known !== undefined) return known;
  const { scale, octaves } = game.config.deepdark.ragged;
  const made = rowNoise(
    game.seed ^ SALT[front],
    key,
    game.world.map.rows,
    scale,
    octaves,
  );
  if (found.size >= 8) found.clear();
  found.set(name, made);
  return made;
}

/** `game`'s noise for `front` now, by its world clock: part way between two drift steps' shapes. */
function noiseNow(game: Session, front: Front): Float64Array {
  const { fronts, ragged } = game.config.deepdark;
  const period = driftPeriod(game.world.W, fronts, ragged);
  if (period <= 0) return shape(game, front, 0);
  const along = game.worldTime / period;
  const key = Math.floor(along);
  const from = shape(game, front, key);
  const to = shape(game, front, key + 1);
  const t = along - key;
  return from.map((a, row) => a + ((to[row] ?? 0) - a) * t);
}

/** The mean edge, across its rows, of `game`'s `front` now. */
const meanFront = (game: Session, front: Front): number =>
  frontAt(
    game.world.W,
    game.config.deepdark.fronts[front],
    game.config.deepdark.fronts.end,
    game.worldTime,
    game.config.deepdark.ragged.amplitude,
  );

/** How far the darkness front has come across `game`'s world now, on the mean across its rows. */
export const darkFront = (game: Session): number => meanFront(game, "dark");

/** How far the deepdark front has come across `game`'s world now, on the mean across its rows. */
export const deepFront = (game: Session): number => meanFront(game, "deep");

/** `game`'s `front`'s edge in each row now. */
function edgeNow(game: Session, front: Front): Float64Array {
  const mean = meanFront(game, front);
  if (mean === -Infinity)
    return new Float64Array(game.world.map.rows).fill(-Infinity);
  const { amplitude } = game.config.deepdark.ragged;
  return noiseNow(game, front).map((noise) => mean + amplitude * noise);
}

/** Each session's fronts, as of the world time and world they were found for. */
const frontsFound = new WeakMap<
  Session,
  { time: number; world: Session["world"]; fronts: Fronts }
>();

/**
 * Where `game`'s fronts' edges lie now, by its world clock: found once for each world time, as
 * rules ask it many times a step.
 */
export function frontsNow(game: Session): Fronts {
  const found = frontsFound.get(game);
  if (found?.time === game.worldTime && found.world === game.world)
    return found.fronts;
  const fronts = { dark: edgeNow(game, "dark"), deep: edgeNow(game, "deep") };
  frontsFound.set(game, { time: game.worldTime, world: game.world, fronts });
  return fronts;
}

/** Whether `game`'s deepdark front has passed `at` now. */
export const behindDeepFront = (
  game: Session,
  at: { readonly x: number; readonly y: number },
): boolean => at.x < edgeAt(frontsNow(game).deep, game.world.map.cell, at.y);

// Each front setting out, heard by everyone wherever they are: a low swell as the darkness comes
// on, and a deeper groan as the deepdark follows it.
const setOutUrls: Readonly<Record<Front, string>> = {
  dark: new URL("./sfx/darkness.mp3", import.meta.url).href,
  deep: new URL("./sfx/deepdark.mp3", import.meta.url).href,
};

/** The world clock passing further than this in one step jumped, as to a host's clock on joining. */
const JUMP = 1;

/** When on its world clock each session last heard the fronts. */
const heard = new WeakMap<Session, number>();

/**
 * Plays each front setting out as `game`'s world clock passes the time it does, at the day's
 * volume. A clock that jumps past it, as a late joiner's does when it takes the host's, plays
 * nothing.
 */
export function hearFronts(game: Session): void {
  const time = game.worldTime;
  const last = heard.get(game);
  heard.set(game, time);
  if (last === undefined || time - last > JUMP || time <= last) return;
  const { fronts } = game.config.deepdark;
  for (const front of ["dark", "deep"] as const) {
    if (last < fronts[front] && time >= fronts[front])
      void game.sfx.play(setOutUrls[front], null, null, {
        volume: game.config.day.volume,
      });
  }
}
