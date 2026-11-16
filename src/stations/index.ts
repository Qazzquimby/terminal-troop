import { mulberry32 } from "../sim/index.js";
import type { Playing } from "../sim/index.js";

/*
 * The radio stations: what any radio plays, a radio carried about or one built into a car. Each
 * station is a folder of songs under `./songs/`, named after the folder, played one after another
 * in a shuffled order and round again, streamed as they play.
 */

/** A station: its name, and its songs' urls. */
export interface Station {
  readonly name: string;
  readonly songs: readonly string[];
}

/**
 * The stations in `files`, song urls by path as `./songs/<station>/<song>`: one per folder, named
 * after it, in order of name, each song once, in order of path.
 */
export function stationsFrom(
  files: Readonly<Record<string, string>>,
): Station[] {
  const byName = new Map<string, string[]>();
  for (const path of Object.keys(files).sort()) {
    const url = files[path];
    const name = /\/songs\/([^/]+)\/[^/]+$/.exec(path)?.[1];
    if (url === undefined || name === undefined) continue;
    byName.set(name, [...(byName.get(name) ?? []), url]);
  }
  return [...byName]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, songs]) => ({ name, songs }));
}

/** Every station there is: whatever folders of songs ship under `./songs/`. */
let stations: readonly Station[] = stationsFrom(
  import.meta.glob<string>("./songs/*/*.{mp3,opus,ogg}", {
    query: "?url",
    import: "default",
    eager: true,
  }),
);

/** Tunes every radio to `list` in place of the stations that ship: for tests. */
export function useStations(list: readonly Station[]): void {
  stations = list;
}

/** How many stations there are. */
export const stationCount = (): number => stations.length;

/** Station `station`'s name; null for no such station. */
export const stationName = (station: number): string | null =>
  stations[station]?.name ?? null;

/** The tag a radio's noise carries, past its maker's kind. */
export const RADIO_TAG = "radio";

/** How a radio plays its station. */
interface Reception {
  /** How loud, 0..1. */
  readonly volume: number;
  /** How far it is heard, in pixels. */
  readonly range: number;
}

/** A seed from `name` and `since`, the same on every client. */
function seedOf(name: string, since: number): number {
  let seed = Math.round(since * 1000) | 0;
  for (const char of name) seed = Math.imul(seed ^ char.charCodeAt(0), 31) | 0;
  return seed;
}

/** `songs` in an order drawn from `seed`: the same order for the same seed. */
function shuffled(songs: readonly string[], seed: number): string[] {
  const random = mulberry32(seed);
  const left = [...songs];
  const order: string[] = [];
  while (left.length > 0)
    order.push(...left.splice(Math.floor(random() * left.length), 1));
  return order;
}

/**
 * Station `station` playing from `since` on the world's clock, its songs one after another in an
 * order drawn from the station and `since`, round and round, as loud and as far as `reception`
 * says; null for no such station. Every client draws the same order and joins it as far in as the
 * world's clock has it.
 */
export function stationPlaying(
  station: number,
  since: number,
  reception: Reception,
): Playing | null {
  const found = stations[station];
  if (found === undefined || found.songs.length === 0) return null;
  return {
    key: `${found.name}@${String(since)}`,
    url: shuffled(found.songs, seedOf(found.name, since)),
    since,
    volume: reception.volume,
    range: reception.range,
    loop: true,
  };
}

/** The station after `station` on the dial, wrapping round; the first for none. */
export const nextStation = (station: number | null): number =>
  station === null ? 0 : (station + 1) % Math.max(stations.length, 1);
