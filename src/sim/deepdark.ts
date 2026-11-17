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
 * time and reaches the right edge at `fronts.end`.
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
}

/**
 * How far across the world, in pixels from its left edge, a front that sets out at `start` and
 * arrives at the right edge at `end` has come by `time`: -Infinity before it sets out, the whole
 * width once it has arrived.
 */
export function frontAt(
  width: number,
  start: number,
  end: number,
  time: number,
): number {
  if (time < start) return -Infinity;
  if (end <= start || time >= end) return width;
  return (width * (time - start)) / (end - start);
}

/** How far the darkness front has come across `game`'s world now: no sunlight falls left of it. */
export const darkFront = (game: Session): number =>
  frontAt(
    game.world.W,
    game.config.deepdark.fronts.dark,
    game.config.deepdark.fronts.end,
    game.worldTime,
  );

/** How far the deepdark front has come across `game`'s world now: all left of it is deepdark. */
export const deepFront = (game: Session): number =>
  frontAt(
    game.world.W,
    game.config.deepdark.fronts.deep,
    game.config.deepdark.fronts.end,
    game.worldTime,
  );

/** Each front, as it sets out. */
type Front = "dark" | "deep";

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
