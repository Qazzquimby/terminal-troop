import { noisesHeardBy, PLAYER_TAG } from "../sim/index.js";
import type { Point, Rng, Session } from "../sim/index.js";

/** How the noises the local player hears are drawn. */
export interface RippleConfig {
  /** How long a ripple lasts, in seconds. */
  readonly duration: number;
  /** Seconds a ring takes to grow out to the noise's full radius; it fades for the rest. */
  readonly expand: number;
  /** Ring thickness, in pixels, for a noise heard as clearly as can be, and for one barely heard. */
  readonly width: { readonly sharp: number; readonly soft: number };
  /** Ring opacity at the start, for a noise heard as clearly as can be, and for one barely heard. */
  readonly alpha: { readonly sharp: number; readonly soft: number };
  readonly colour: string;
  /**
   * A noise something other than a player made where the local player can't see: a soft glow at
   * the edge of the screen, the way it seemed to come from, for as long as a ripple lasts.
   */
  readonly edge: {
    /** The glow's radius, in screen pixels. */
    readonly radius: number;
    /** How far in from the screen's edge its centre sits, in screen pixels. */
    readonly inset: number;
    /** Its opacity at the start, for a noise heard as clearly as can be, and for one barely heard. */
    readonly alpha: { readonly sharp: number; readonly soft: number };
    readonly colour: string;
  };
}

/** A noise the local player heard, as it is drawn: an expanding ring, or a glow at the screen's edge. */
export interface Ripple {
  /** Where the noise seemed to come from. */
  readonly at: Point;
  /** Where it was really made, to tell whether the local player can see it. */
  readonly origin: Point;
  /** From 1 for a noise made where the local player stands, down to 0 at the edge of its radius. */
  readonly clarity: number;
  /** How far the noise carries, in pixels: the ring grows out to this. */
  readonly radius: number;
  /** Whether a player made it: a player's noise is always drawn as a ring. */
  readonly player: boolean;
  /** When it was heard, in ms on the frame clock. */
  readonly startedAt: number;
}

/** A ripple as drawn at one moment: its ring's centre, radius, thickness and opacity. */
export interface RippleRing extends Point {
  readonly radius: number;
  readonly width: number;
  readonly alpha: number;
}

/** A glow at the screen's edge, in screen pixels: its centre, radius and opacity. */
export interface EdgeGlow extends Point {
  readonly radius: number;
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
        ...heard.map(({ at, origin, clarity, radius, tags }) => ({
          at,
          origin,
          clarity,
          radius,
          player: tags.includes(PLAYER_TAG),
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

/** How far through its life `ripple` is at `time` in ms, 0..1; null outside it. */
function progressOf(
  ripple: Ripple,
  time: number,
  config: RippleConfig,
): number | null {
  const progress = (time - ripple.startedAt) / (config.duration * 1000);
  return progress < 0 || progress >= 1 ? null : progress;
}

/**
 * `ripple` as of `time` in ms, or null before it starts or once it is over. It eases out to the
 * noise's radius over the expand time, fading as it does and after; the less clearly it was
 * heard, the thicker and fainter its ring.
 */
export function rippleRing(
  ripple: Ripple,
  time: number,
  config: RippleConfig,
): RippleRing | null {
  const progress = progressOf(ripple, time, config);
  if (progress === null) return null;
  const grown = Math.min(1, (time - ripple.startedAt) / (config.expand * 1000));
  const softness = 1 - ripple.clarity;
  return {
    x: ripple.at.x,
    y: ripple.at.y,
    radius: ripple.radius * (1 - (1 - grown) ** 2),
    width: lerp(config.width.sharp, config.width.soft, softness),
    alpha:
      lerp(config.alpha.sharp, config.alpha.soft, softness) * (1 - progress),
  };
}

/**
 * The glow for `ripple` as of `time` in ms, at the edge of a `view` of screen pixels on the line
 * from `from` towards `towards`, both in screen pixels, or null before it starts or once it is
 * over. Inset from the edge, and fading as a ring does.
 */
export function edgeGlow(
  ripple: Ripple,
  time: number,
  config: RippleConfig,
  view: { readonly width: number; readonly height: number },
  from: Point,
  towards: Point,
): EdgeGlow | null {
  const progress = progressOf(ripple, time, config);
  if (progress === null) return null;
  const { edge } = config;
  const left = edge.inset;
  const top = edge.inset;
  const right = view.width - edge.inset;
  const bottom = view.height - edge.inset;
  const origin = {
    x: Math.min(right, Math.max(left, from.x)),
    y: Math.min(bottom, Math.max(top, from.y)),
  };
  const dx = towards.x - origin.x;
  const dy = towards.y - origin.y;
  // The furthest along the line the inset box reaches, as a multiple of the step to `towards`.
  const reach = Math.min(
    dx > 0
      ? (right - origin.x) / dx
      : dx < 0
        ? (left - origin.x) / dx
        : Infinity,
    dy > 0
      ? (bottom - origin.y) / dy
      : dy < 0
        ? (top - origin.y) / dy
        : Infinity,
  );
  const t = Number.isFinite(reach) ? reach : 0;
  const softness = 1 - ripple.clarity;
  return {
    x: origin.x + dx * t,
    y: origin.y + dy * t,
    radius: edge.radius,
    alpha: lerp(edge.alpha.sharp, edge.alpha.soft, softness) * (1 - progress),
  };
}
