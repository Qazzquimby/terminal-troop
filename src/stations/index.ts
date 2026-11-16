import type { Playing } from "../sim/index.js";

/*
 * The radio stations: what any radio plays, a radio carried about or one built into a car. Each
 * station is one song played over and over, streamed as it plays.
 */

/** Each station's song, by station number. */
export const STATIONS: readonly string[] = [
  new URL("./songs/rips/breakcore_delivery__bachrees.opus", import.meta.url)
    .href,
  new URL("./songs/rips/baka_mitai.opus", import.meta.url).href,
  new URL("./songs/rips/overworld_theme_unused_smw.opus", import.meta.url).href,
  new URL("./songs/song-4.mp3", import.meta.url).href,
];

/** The tag a radio's noise carries, past its maker's kind. */
export const RADIO_TAG = "radio";

/** How a radio plays its station. */
interface Reception {
  /** How loud, 0..1. */
  readonly volume: number;
  /** How far it is heard, in pixels. */
  readonly range: number;
}

/**
 * Station `station` playing on a loop from `since` on the world's clock, as loud and as far as
 * `reception` says; null for no such station.
 */
export function stationPlaying(
  station: number,
  since: number,
  reception: Reception,
): Playing | null {
  const url = STATIONS[station];
  if (url === undefined) return null;
  return {
    key: `${String(station)}@${String(since)}`,
    url,
    since,
    volume: reception.volume,
    range: reception.range,
    loop: true,
  };
}

/** The station after `station` on the dial, wrapping round; the first for none. */
export const nextStation = (station: number | null): number =>
  station === null ? 0 : (station + 1) % STATIONS.length;
