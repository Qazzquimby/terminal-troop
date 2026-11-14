import type { Point, Rng } from "./map.js";
import type { Session } from "./session.js";

/**
 * The tag every noise a player makes carries. An entity's noise carries its kind's name instead,
 * so a listener can tell who made what it hears and ignore its own kind.
 */
export const PLAYER_TAG = "player";

/**
 * A sound made in the world, heard by whatever stands within its radius in the step it is made in.
 *
 * Its tags say what made it: the kind of its maker (`PLAYER_TAG`, or an entity kind's name) first,
 * then any the maker adds to say how, such as "footstep" or "voice". Listeners filter on them.
 */
export interface Noise {
  readonly at: Point;
  /** How far it carries, in pixels: anything within this of `at` hears it. */
  readonly radius: number;
  /** The id of the player or entity that made it, if any. */
  readonly source?: string;
  readonly tags: readonly string[];
}

/** How exactly noise is heard. */
export interface NoiseConfig {
  /**
   * Furthest a heard noise's reported spot strays from where it was made, as a fraction of its
   * distance from the listener.
   */
  readonly blur: number;
}

/** Something that hears noise: the point it stands at, its random draws, and what it ignores. */
export interface Listener {
  readonly at: Point;
  /** Draws where each heard noise seems to come from. */
  readonly rng: Rng;
  /** A noise carrying any of these tags goes unheard, such as a kind ignoring its own noise. */
  readonly ignores?: readonly string[];
}

/** A noise as a listener hears it. */
export interface Heard {
  /** Where it seems to come from: the further off it was made, the further this may stray. */
  readonly at: Point;
  /**
   * Where it was really made. For drawing what the local player hears, not for an entity to act
   * on: that should go by `at`.
   */
  readonly origin: Point;
  /** From 1 for a noise made where the listener stands, down to 0 at the edge of its radius. */
  readonly clarity: number;
  /** How far it carries, in pixels. */
  readonly radius: number;
  /**
   * How loud it is where the listener stands: how far past the listener, in pixels, it still
   * carries. A big noise far off can be as loud as a small one close by.
   */
  readonly loudness: number;
  readonly source: string | null;
  readonly tags: readonly string[];
}

/** Makes `noise` for the rest of this step. */
export function emitNoise(game: Session, noise: Noise): void {
  game.noises.push(noise);
}

/**
 * The tags saying what kind of thing `id` is: `PLAYER_TAG` for a player; for a world entity, its
 * kind's name, then the tags its kind declares; none for anything else.
 */
export function kindTags(game: Session, id: string): string[] {
  if (game.players.has(id)) return [PLAYER_TAG];
  const entity = game.entities.get(id);
  if (entity === undefined) return [];
  const declared = game.entityTypes.get(entity.kind)?.tags ?? [];
  for (const [name, kind] of game.kindIds)
    if (kind === entity.kind) return [name, ...declared];
  return [...declared];
}

/** Whether the player or world entity `id` carries any of `tags` among its `kindTags`. */
export function hasKindTag(
  game: Session,
  id: string,
  tags: readonly string[],
): boolean {
  return kindTags(game, id).some((tag) => tags.includes(tag));
}

/** A noise `by` makes, as `emitNoise` takes it. */
export interface Made {
  readonly at: Point;
  readonly radius: number;
  /** Tags past the maker's kind, saying how it was made. */
  readonly tags?: readonly string[];
}

/** Makes a noise for the rest of this step, tagged with `by`'s kind and then `made`'s own tags. */
export function makeNoise(
  game: Session,
  by: { readonly id: string },
  made: Made,
): void {
  emitNoise(game, {
    at: { x: made.at.x, y: made.at.y },
    radius: made.radius,
    source: by.id,
    tags: [...kindTags(game, by.id), ...(made.tags ?? [])],
  });
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
 * The noises made this step whose radius reaches `listener` and that carry none of the tags it
 * ignores, oldest first, each placed with a blur that grows with its distance. Each one heard
 * takes two draws from the listener's generator.
 */
export function noisesHeardBy(game: Session, listener: Listener): Heard[] {
  const heard: Heard[] = [];
  const ignores = listener.ignores ?? [];
  for (const noise of game.noises) {
    if (noise.tags.some((tag) => ignores.includes(tag))) continue;
    const distance = Math.hypot(
      noise.at.x - listener.at.x,
      noise.at.y - listener.at.y,
    );
    if (!(distance <= noise.radius)) continue;
    heard.push({
      at: blurred(noise.at, distance * game.config.noise.blur, listener.rng),
      origin: noise.at,
      clarity: noise.radius > 0 ? 1 - distance / noise.radius : 1,
      radius: noise.radius,
      loudness: noise.radius - distance,
      source: noise.source ?? null,
      tags: noise.tags,
    });
  }
  return heard;
}
