import { expect, test } from "vitest";
import { placeInList } from "../audio/index.js";
import {
  RADIO_CHANNEL,
  nextStation,
  stationCount,
  stationName,
  stationPlaying,
  stationsFrom,
  useStations,
} from "./index.js";

const reception = { volume: 0.5, range: 300 };

test("each folder under songs is a station named after it, its songs in order of path", () => {
  expect(
    stationsFrom({
      "./songs/Zed FM/b.opus": "/z/b",
      "./songs/Zed FM/a.mp3": "/z/a",
      "./songs/Alpha/one.ogg": "/a/1",
    }),
  ).toEqual([
    { name: "Alpha", songs: ["/a/1"] },
    { name: "Zed FM", songs: ["/z/a", "/z/b"] },
  ]);
});

test("a station plays every one of its songs, round and round, in a shuffled order drawn from it alone, on the radio channel", () => {
  const songs = Array.from({ length: 12 }, (_, i) => `/s/${String(i)}.opus`);
  useStations([
    { name: "Test FM", songs },
    { name: "Other FM", songs },
  ]);
  const playing = stationPlaying(0, reception, "41.5");
  expect(playing).toMatchObject({
    since: 0,
    loop: true,
    channel: RADIO_CHANNEL,
    ...reception,
  });
  const order = typeof playing?.url === "object" ? playing.url : [];
  expect([...order].sort()).toEqual([...songs].sort());
  // Shuffled, the same for every radio on the station, and drawn afresh for another station.
  expect(order).not.toEqual(songs);
  expect(stationPlaying(0, reception, "90")?.url).toEqual(order);
  expect(stationPlaying(0, { volume: 1, range: 900 })?.url).toEqual(order);
  expect(stationPlaying(1, reception)?.url).not.toEqual(order);
});

test("radios on one station play the same song at the same place, however late each was tuned in", () => {
  const songs = ["/a", "/b", "/c"];
  const lengths = new Map([
    ["/a", 100],
    ["/b", 50],
    ["/c", 200],
  ]);
  useStations([{ name: "Sync FM", songs }]);
  const carried = stationPlaying(0, reception, "12");
  const car = stationPlaying(0, { volume: 1, range: 900 });
  // Each radio is heard where it is: two on one station play under keys of their own.
  expect(carried?.key).not.toEqual(car?.key);
  /** The song and the place in it a client joins `playing` at, at `worldTime`. */
  const joined = (playing: typeof car, worldTime: number) => {
    const list = typeof playing?.url === "object" ? playing.url : [];
    const place = placeInList(
      list.map((url) => lengths.get(url) ?? 0),
      worldTime - (playing?.since ?? 0),
      playing?.loop ?? false,
    );
    return place === null
      ? null
      : { song: list[place.index], offset: place.offset };
  };
  for (const worldTime of [0, 37, 149.5, 350, 351, 1000])
    expect(joined(carried, worldTime)).toEqual(joined(car, worldTime));
  // The schedule runs on whether or not anything listens: round again after all 350 seconds.
  expect(joined(car, 1000)).toEqual(joined(car, 300));
  const first = joined(car, 0)?.song;
  expect(joined(car, 10)).toEqual({ song: first, offset: 10 });
});

test("the dial steps through the stations by name, wrapping round; there is nothing past them", () => {
  useStations([
    { name: "One", songs: ["/1"] },
    { name: "Two", songs: ["/2"] },
  ]);
  expect(stationCount()).toBe(2);
  expect(nextStation(null)).toBe(0);
  expect(nextStation(0)).toBe(1);
  expect(nextStation(1)).toBe(0);
  expect(stationName(1)).toBe("Two");
  expect(stationName(2)).toBeNull();
  expect(stationPlaying(2, reception)).toBeNull();
});
