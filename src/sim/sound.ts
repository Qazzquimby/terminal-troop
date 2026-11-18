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

/**
 * A short name for the sound at `url`, the same on every client of one build, sent in its place.
 * A built url can be long: Vite inlines a small file as a base64 data url.
 */
export function soundKey(url: string): string {
  // cyrb53: 53 bits, so a few hundred sounds collide with odds near 1e-11.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Every sound content has declared, by its key. */
const declared = new Map<string, Sound>();

/** Declares a sound, once, where its content defines it. */
export function sound(spec: Sound): Sound {
  const key = soundKey(spec.url);
  const known = declared.get(key);
  if (known !== undefined && known.url !== spec.url)
    throw new Error(`Sounds share a key: ${known.url} and ${spec.url}`);
  declared.set(key, spec);
  return spec;
}

/** The sound declared under `key`; undefined for one no content declared. */
export const declaredSound = (key: string): Sound | undefined =>
  declared.get(key);

/** Every sound content has declared so far. */
export const declaredSounds = (): Sound[] => [...declared.values()];
