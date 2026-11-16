import { expect, test } from "vitest";
import {
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

test("a station plays every one of its songs, round and round, in an order drawn from it and when it was switched on", () => {
  const songs = Array.from({ length: 12 }, (_, i) => `/s/${String(i)}.opus`);
  useStations([{ name: "Test FM", songs }]);
  const playing = stationPlaying(0, 41.5, reception);
  expect(playing).toMatchObject({ since: 41.5, loop: true, ...reception });
  const order = typeof playing?.url === "object" ? playing.url : [];
  expect([...order].sort()).toEqual([...songs].sort());
  // Shuffled, the same on every client for the same playing, and otherwise drawn afresh.
  expect(order).not.toEqual(songs);
  expect(stationPlaying(0, 41.5, reception)?.url).toEqual(order);
  expect(stationPlaying(0, 90, reception)?.url).not.toEqual(order);
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
  expect(stationPlaying(2, 0, reception)).toBeNull();
});
