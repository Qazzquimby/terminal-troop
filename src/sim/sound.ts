/** A sound content can make: what plays, and how loud. */
export interface Sound {
  readonly url: string;
  /** How loud it plays, 0..1; full when left out. */
  readonly volume?: number;
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
