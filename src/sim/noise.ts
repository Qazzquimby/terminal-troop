import { z } from "zod";
import { contentEvent } from "./content-event.js";
import type { Point, Rng } from "./map.js";
import type { Session } from "./session.js";

/** A sound made in the world, heard by whatever listens in the step it is made in. */
export interface Noise {
  readonly at: Point;
  /** How far it carries, as a multiple of a listener's hearing range. */
  readonly loudness: number;
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

/** Something that hears noise: where it stands, how far it hears, and its random draws. */
interface Listener {
  readonly at: Point;
  /** How far it hears a noise of loudness 1, in pixels. */
  readonly range: number;
  /** Draws where each heard noise seems to come from. */
  readonly rng: Rng;
}

/** A noise as a listener hears it. */
export interface Heard {
  /** Where it seems to come from: the further off it was made, the further this may stray. */
  readonly at: Point;
  /** From 1 for a noise made where the listener stands, down towards 0 at the edge of its reach. */
  readonly clarity: number;
  readonly loudness: number;
  readonly source: string | null;
}

/** Makes `noise` for the rest of this step. */
export function emitNoise(game: Session, noise: Noise): void {
  game.noises.push(noise);
}

/** How far, in pixels, `noise` carries to a listener of `range` at `at`. */
function reach(noise: Noise, range: number): number {
  return noise.loudness * range;
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
 * The noises made this step that carry to `listener`, oldest first, each placed with a blur
 * that grows with its distance. Each one heard takes two draws from the listener's generator.
 */
export function noisesHeardBy(game: Session, listener: Listener): Heard[] {
  const heard: Heard[] = [];
  for (const noise of game.noises) {
    const distance = Math.hypot(
      noise.at.x - listener.at.x,
      noise.at.y - listener.at.y,
    );
    const carries = reach(noise, listener.range);
    if (!(distance < carries)) continue;
    heard.push({
      at: blurred(noise.at, distance * game.config.noise.blur, listener.rng),
      clarity: 1 - distance / carries,
      loudness: noise.loudness,
      source: noise.source ?? null,
    });
  }
  return heard;
}

/** A noise as it travels from the host. */
const NoiseMade = z.object({
  x: z.number(),
  y: z.number(),
  loudness: z.number().min(0),
  source: z.string().min(1).max(64).nullable(),
});

/** A noise the host made, sent to every client, the host's own included, to make there. */
export const noiseMade = contentEvent({
  schema: NoiseMade,
  to: "all",
  from: "host",
  receive(game, { x, y, loudness, source }) {
    emitNoise(
      game,
      source === null
        ? { at: { x, y }, loudness }
        : { at: { x, y }, loudness, source },
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
    loudness: noise.loudness,
    source: noise.source ?? null,
  });
}
