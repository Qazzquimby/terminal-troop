import { afterEach, describe, expect, test, vi } from "vitest";
import { createSfx, rangedFalloff, spatialMix } from "./audio.js";

const falloff = { full: 100, silent: 1000, pan: 500 };
const listener = { x: 0, y: 0 };
const volumeAt = (x: number, range?: number): number =>
  spatialMix({ x, y: 0 }, listener, rangedFalloff(falloff, range)).volume;

describe("a sound with a range", () => {
  test("fades to silence at its range, not the falloff's", () => {
    expect(volumeAt(299, 300)).toBeGreaterThan(0);
    expect(volumeAt(300, 300)).toBe(0);
    expect(volumeAt(600, 300)).toBe(0);
    expect(volumeAt(600)).toBeGreaterThan(0);
  });

  test("is full close by, and no further out than half its range", () => {
    expect(volumeAt(50, 1500)).toBe(1);
    expect(volumeAt(100, 1500)).toBe(1);
    expect(volumeAt(150, 1500)).toBeLessThan(1);
    expect(volumeAt(50, 100)).toBe(1);
    expect(volumeAt(60, 100)).toBeLessThan(1);
  });

  test("of nothing is never heard", () => {
    expect(volumeAt(1, 0)).toBe(0);
  });
});

describe("a sound whose file is missing", () => {
  function stubAudio(): { fetches: () => number; warnings: () => number } {
    let fetches = 0;
    vi.stubGlobal("fetch", () => {
      fetches += 1;
      // A dev server answers a missing file with its index page, so the fetch succeeds.
      return Promise.resolve(new Response("<!doctype html>", { status: 200 }));
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData(): Promise<never> {
          return Promise.reject(new Error("Unable to decode audio data"));
        }
        resume(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return { fetches: () => fetches, warnings: () => warn.mock.calls.length };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("plays as silence, warned about and fetched once", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);

    const first = await sfx.play("./sfx/missing.mp3", null, null);
    await sfx.play("./sfx/missing.mp3", null, null);
    const loop = await sfx.playLoop("hum", "./sfx/missing.mp3", null, null);

    expect(() => {
      first.stop();
    }).not.toThrow();
    expect(loop).not.toBeNull();
    expect(audio.fetches()).toBe(1);
    expect(audio.warnings()).toBe(1);
  });
});
