import { noisesHeardBy } from "../sim/index.js";
import type { Point, Rng, Session } from "../sim/index.js";

/** How the noises the local player hears are drawn. */
export interface RippleConfig {
  /** How long a ripple lasts, in seconds. */
  readonly duration: number;
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
  /** From 1 for a noise made where the local player stands, down to 0 at the edge of its radius. */
  readonly clarity: number;
  /** How far the noise carries, in pixels: the ring grows out to this. */
  readonly radius: number;
  /** When it was heard, in ms on the frame clock. */
  readonly startedAt: number;
}

/** A ripple as drawn at one moment: its ring's centre, radius, thickness and opacity. */
export interface RippleRing extends Point {
  readonly radius: number;
  readonly width: number;
  readonly alpha: number;
}

/** The noises the local player has heard lately, kept for drawing on this client alone. */
export interface Ripples {
  readonly config: RippleConfig;
  /** The ripples heard and not yet dropped, oldest first. */
  readonly list: readonly Ripple[];
  /**
   * Call after each sim step, with the time in ms the step ran up to. Drops the ripples over by
   * then, and adds one for each noise of that step whose radius reaches the local player, its own
   * footsteps included.
   */
  hear(game: Session, time: number): void;
  /** Drops every ripple, as when the local player enters another room. */
  clear(): void;
}

/** No ripples yet; `rng` blurs where each heard noise seems to come from. */
export function createRipples(config: RippleConfig, rng: Rng): Ripples {
  const durationMs = config.duration * 1000;
  let list: readonly Ripple[] = [];
  return {
    config,
    get list() {
      return list;
    },
    hear(game, time) {
      const heard = noisesHeardBy(game, { at: game.local, rng });
      list = [
        ...list.filter((ripple) => time - ripple.startedAt < durationMs),
        ...heard.map(({ at, clarity, radius }) => ({
          at,
          clarity,
          radius,
          startedAt: time,
        })),
      ];
    },
    clear() {
      list = [];
    },
  };
}

const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

/**
 * `ripple` as of `time` in ms, or null before it starts or once it is over. It eases out to the
 * noise's radius as it fades; the less clearly it was heard, the thicker and fainter its ring.
 */
export function rippleRing(
  ripple: Ripple,
  time: number,
  config: RippleConfig,
): RippleRing | null {
  const progress = (time - ripple.startedAt) / (config.duration * 1000);
  if (progress < 0 || progress >= 1) return null;
  const softness = 1 - ripple.clarity;
  return {
    x: ripple.at.x,
    y: ripple.at.y,
    radius: ripple.radius * (1 - (1 - progress) ** 2),
    width: lerp(config.width.sharp, config.width.soft, softness),
    alpha:
      lerp(config.alpha.sharp, config.alpha.soft, softness) * (1 - progress),
  };
}
