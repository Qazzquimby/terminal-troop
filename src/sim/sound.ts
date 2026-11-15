/**
 * A sound content can make: what plays, how loud, and how far it carries.
 *
 * A sound with a range is heard out to it, by players' ears and, as a noise, by whatever listens
 * in the world: playing it in an effect makes that noise too, unless `noise` is false.
 */
export interface Sound {
  readonly url: string;
  /** How loud it plays, 0..1; full when left out. */
  readonly volume?: number;
  /**
   * How far it is heard, in pixels, fading to silence there. Left out, it fades as the audio
   * config says, and makes no noise.
   */
  readonly range?: number;
  /** Whether playing it makes a noise out to its range; true when left out. */
  readonly noise?: boolean;
}

/** How far, in pixels, the noise playing `sound` makes carries; undefined for none. */
export function soundNoise(sound: Sound): number | undefined {
  return sound.noise === false ? undefined : sound.range;
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

/** Every sound content has declared so far. */
export const declaredSounds = (): Sound[] => [...declared.values()];
