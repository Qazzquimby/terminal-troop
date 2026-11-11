import type { Point, Rng } from "./map.js";
import { noisesHeardBy } from "./noise.js";
import type { Session } from "./session.js";

/** How the local player hears noise, and how what it hears is drawn. */
export interface RippleConfig {
  /** How far, in pixels, the local player hears a noise of loudness 1. */
  readonly hearingRange: number;
  /** How long a ripple lasts, in sim seconds. */
  readonly duration: number;
  /** How wide a ripple grows, in pixels: at least `min`, plus `perLoudness` for each unit of loudness. */
  readonly radius: { readonly min: number; readonly perLoudness: number };
  /** Ring thickness, in pixels, for a noise heard as clearly as can be, and for one barely heard. */
  readonly width: { readonly sharp: number; readonly soft: number };
  /** Ring opacity at the start, for a noise heard as clearly as can be, and for one barely heard. */
  readonly alpha: { readonly sharp: number; readonly soft: number };
  readonly colour: string;
}

/** A noise the local player heard, as it is drawn: an expanding ring that fades. */
export interface Ripple {
  /** Where the noise seemed to come from. */
  readonly at: Point;
  /** From 1 for a noise made where the local player stands, down towards 0 at the edge of its hearing. */
  readonly clarity: number;
  readonly loudness: number;
  /** When it was heard, in sim seconds. */
  readonly startedAt: number;
}

/** The ripples the local player sees, and the draws that place them. */
export interface Ripples {
  list: readonly Ripple[];
  readonly rng: Rng;
}

/**
 * Drops the ripples that have run their course, and adds one for each noise made this step that
 * carries to the local player, its own footsteps included.
 */
export function hearRipples(game: Session): void {
  const { duration, hearingRange } = game.config.ripples;
  const kept = game.ripples.list.filter(
    (ripple) => game.time - ripple.startedAt < duration,
  );
  const heard = noisesHeardBy(game, {
    at: game.local,
    range: hearingRange,
    rng: game.ripples.rng,
  });
  game.ripples.list = [
    ...kept,
    ...heard.map(({ at, clarity, loudness }) => ({
      at,
      clarity,
      loudness,
      startedAt: game.time,
    })),
  ];
}

/** A ripple as drawn at one moment: its ring's centre, radius, thickness and opacity. */
export interface RippleRing extends Point {
  readonly radius: number;
  readonly width: number;
  readonly alpha: number;
}

const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

/**
 * `ripple` as of sim time `time`, or null before it starts or once it is over. It eases out to
 * its full radius as it fades; the less clearly it was heard, the thicker and fainter its ring.
 */
export function rippleRing(
  ripple: Ripple,
  time: number,
  config: RippleConfig,
): RippleRing | null {
  const progress = (time - ripple.startedAt) / config.duration;
  if (progress < 0 || progress >= 1) return null;
  const full = config.radius.min + config.radius.perLoudness * ripple.loudness;
  const softness = 1 - ripple.clarity;
  return {
    x: ripple.at.x,
    y: ripple.at.y,
    radius: full * (1 - (1 - progress) ** 2),
    width: lerp(config.width.sharp, config.width.soft, softness),
    alpha:
      lerp(config.alpha.sharp, config.alpha.soft, softness) * (1 - progress),
  };
}
