import type { Point, Session } from "../sim/index.js";

/** How a blow seen landing is drawn: a disc that swells and fades. */
export interface FlashConfig {
  /** How long a flash lasts, in seconds. */
  readonly duration: number;
  /** Its size at the start, as a fraction of the blow's radius; it swells to the full radius. */
  readonly start: number;
  /** Opacity of the fill at the start; the ring starts opaque. */
  readonly fill: number;
  /** Ring thickness, in pixels. */
  readonly width: number;
  /** Its colour for a blow that connected, and for one that did not. */
  readonly colour: { readonly hit: string; readonly miss: string };
}

/** A blow seen landing, as it is drawn. */
interface Flash {
  readonly at: Point;
  readonly radius: number;
  readonly hit: boolean;
  /** When it was seen, in ms on the frame clock. */
  readonly startedAt: number;
}

/** A flash as drawn at one moment. */
export interface FlashDisc extends Point {
  readonly radius: number;
  /** How far it has faded, from 1 at the start to 0 at the end. */
  readonly fade: number;
  readonly colour: string;
}

/** The blows the local player has seen land lately, kept for drawing on this client alone. */
export interface Flashes {
  readonly config: FlashConfig;
  /** The flashes seen and not yet dropped, oldest first. */
  readonly list: readonly Flash[];
  /**
   * Call after each sim step, with the time in ms the step ran up to. Drops the flashes over by
   * then, and adds one for each flash shown in that step.
   */
  see(game: Session, time: number): void;
  /** Drops every flash, as when the local player enters another room. */
  clear(): void;
}

export function createFlashes(config: FlashConfig): Flashes {
  const durationMs = config.duration * 1000;
  let list: readonly Flash[] = [];
  return {
    config,
    get list() {
      return list;
    },
    see(game, time) {
      list = [
        ...list.filter((flash) => time - flash.startedAt < durationMs),
        ...game.flashes.map(({ at, radius, hit }) => ({
          at,
          radius,
          hit,
          startedAt: time,
        })),
      ];
    },
    clear() {
      list = [];
    },
  };
}

/** `flash` as of `time` in ms, or null before it starts or once it is over. */
export function flashDisc(
  flash: Flash,
  time: number,
  config: FlashConfig,
): FlashDisc | null {
  const progress = (time - flash.startedAt) / (config.duration * 1000);
  if (progress < 0 || progress >= 1) return null;
  return {
    x: flash.at.x,
    y: flash.at.y,
    radius: flash.radius * (config.start + (1 - config.start) * progress),
    fade: 1 - progress,
    colour: flash.hit ? config.colour.hit : config.colour.miss,
  };
}
