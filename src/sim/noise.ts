import { z } from "zod";
import { contentEvent } from "./content-event.js";
import type { Point, Rng } from "./map.js";
import type { Session } from "./session.js";

/** A sound made in the world, heard by whatever stands within its radius in the step it is made in. */
export interface Noise {
  readonly at: Point;
  /** How far it carries, in pixels: anything within this of `at` hears it. */
  readonly radius: number;
  /** The id of the player or entity that made it, if any. */
  readonly source?: string;
}

/** How exactly noise is heard. */
export interface NoiseConfig {
  /**
   * Furthest a heard noise's reported spot strays from where it was made, as a fraction of its
   * distance from the listener.
   */
  readonly blur: number;
}

/** Something that hears noise: the point it stands at, and its random draws. */
interface Listener {
  readonly at: Point;
  /** Draws where each heard noise seems to come from. */
  readonly rng: Rng;
}

/** A noise as a listener hears it. */
export interface Heard {
  /** Where it seems to come from: the further off it was made, the further this may stray. */
  readonly at: Point;
  /** From 1 for a noise made where the listener stands, down to 0 at the edge of its radius. */
  readonly clarity: number;
  /** How far it carries, in pixels. */
  readonly radius: number;
  readonly source: string | null;
}

/** Makes `noise` for the rest of this step. */
export function emitNoise(game: Session, noise: Noise): void {
  game.noises.push(noise);
}

/** A point at most `spread` from `at`, spread evenly over the disc. */
function blurred(at: Point, spread: number, rng: Rng): Point {
  const angle = rng() * Math.PI * 2;
  const distance = spread * Math.sqrt(rng());
  return {
    x: at.x + Math.cos(angle) * distance,
    y: at.y + Math.sin(angle) * distance,
  };
}

/**
 * The noises made this step whose radius reaches `listener`, oldest first, each placed with a
 * blur that grows with its distance. Each one heard takes two draws from the listener's generator.
 */
export function noisesHeardBy(game: Session, listener: Listener): Heard[] {
  const heard: Heard[] = [];
  for (const noise of game.noises) {
    const distance = Math.hypot(
      noise.at.x - listener.at.x,
      noise.at.y - listener.at.y,
    );
    if (!(distance <= noise.radius)) continue;
    heard.push({
      at: blurred(noise.at, distance * game.config.noise.blur, listener.rng),
      clarity: noise.radius > 0 ? 1 - distance / noise.radius : 1,
      radius: noise.radius,
      source: noise.source ?? null,
    });
  }
  return heard;
}

/** A noise as it travels from the host. */
const NoiseMade = z.object({
  x: z.number(),
  y: z.number(),
  radius: z.number().min(0),
  source: z.string().min(1).max(64).nullable(),
});

/** A noise the host made, sent to every client, the host's own included, to make there. */
export const noiseMade = contentEvent({
  schema: NoiseMade,
  to: "all",
  from: "host",
  receive(game, { x, y, radius, source }) {
    emitNoise(
      game,
      source === null
        ? { at: { x, y }, radius }
        : { at: { x, y }, radius, source },
    );
  },
});

/**
 * Makes `noise` on every client, in the step after the room sends it: for noise that starts
 * where only the host runs, such as an entity's update or an item's effect.
 */
export function broadcastNoise(game: Session, noise: Noise): void {
  noiseMade.send(game, {
    x: noise.at.x,
    y: noise.at.y,
    radius: noise.radius,
    source: noise.source ?? null,
  });
}
