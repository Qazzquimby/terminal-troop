import { sum } from "lodash-es";

/** Where in a list of sounds playing one after another: which one, and how far into it. */
export interface Place {
  readonly index: number;
  readonly offset: number;
}

/**
 * Where a list of sounds `durations` seconds long, played one after another from its first and,
 * if it loops, round again, is `elapsed` seconds after it started. A sound of no length is passed
 * over. Null once a list that does not loop has ended, or for a list with nothing in it to play.
 */
export function placeInList(
  durations: readonly number[],
  elapsed: number,
  loop: boolean,
): Place | null {
  const total = sum(durations);
  if (total <= 0 || (!loop && elapsed >= total)) return null;
  let left = loop ? ((elapsed % total) + total) % total : Math.max(elapsed, 0);
  for (const [index, length] of durations.entries()) {
    if (left < length) return { index, offset: left };
    left -= length;
  }
  // Rounding left it at the very end: the start again.
  return placeInList(durations, 0, loop);
}

/** The sound to play from its start after sound `index` of the list ends; null for none. */
export function nextInList(
  durations: readonly number[],
  index: number,
  loop: boolean,
): Place | null {
  for (let step = 1; step <= durations.length; step++) {
    const next = index + step;
    if (!loop && next >= durations.length) return null;
    const wrapped = next % durations.length;
    if ((durations[wrapped] ?? 0) > 0) return { index: wrapped, offset: 0 };
  }
  return null;
}
