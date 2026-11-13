import type { Point } from "./map.js";
import { broadcastNoise } from "./noise.js";
import type { Session } from "./session.js";

/** A sound content can make: what plays, how loud, and how far its noise carries, if it makes any. */
export interface Sound {
  readonly url: string;
  /** How loud it plays, 0..1; full when left out. */
  readonly volume?: number;
  /** How far, in pixels, the noise it makes carries; it makes none when left out. */
  readonly noise?: number;
}

/** Every sound content has declared, by its url. */
const declared = new Map<string, Sound>();

/** Declares a sound, once, where its content defines it. */
export function sound(spec: Sound): Sound {
  declared.set(spec.url, spec);
  return spec;
}

/** The sound declared at `url`; undefined for one no content declared. */
export const declaredSound = (url: string): Sound | undefined =>
  declared.get(url);

/**
 * Plays `made` at `at` for this client's listener. A sound that makes noise makes it once, from
 * the host, on every client: a sound every client plays still makes one noise. `source` is the
 * id of the player or entity that made it, if any.
 */
export function makeSound(
  game: Session,
  made: Sound,
  at: Point,
  source?: string,
): void {
  void game.sfx.play(
    made.url,
    at,
    game.local,
    made.volume === undefined ? {} : { volume: made.volume },
  );
  if (made.noise === undefined || !game.hosting) return;
  const noise = { at: { x: at.x, y: at.y }, radius: made.noise };
  broadcastNoise(game, source === undefined ? noise : { ...noise, source });
}
