import { afterEach, describe, expect, test, vi } from "vitest";
import { settle, stubAudio } from "../integration/fake-audio.js";
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

describe("sound made rather than loaded", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("plays its samples placed as a loaded sound is, fading out to its range", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);
    const near = { x: 0, y: 0 };
    void sfx.playSamples(new Float32Array(441), 22_050, near, near, {
      range: 400,
    });
    await settle();
    const [made] = audio.sounds();
    expect(made?.url).toBe("samples:441@22050");
    expect(made?.volume()).toBe(1);
    sfx.listen({ x: 400, y: 0 });
    expect(made?.volume()).toBe(0);
  });

  test("of no samples plays nothing", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);
    const handle = await sfx.playSamples(
      new Float32Array(0),
      22_050,
      null,
      null,
    );
    expect(audio.sounds()).toHaveLength(0);
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });
});

describe("a positioned sound still playing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("is heard anew from wherever the listener goes", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);
    void sfx.play("long.mp3", { x: 0, y: 0 }, { x: 0, y: 0 }, { range: 400 });
    await settle();
    const [long] = audio.sounds();
    expect(long?.volume()).toBe(1);

    sfx.listen({ x: 400, y: 0 });
    expect(long?.volume()).toBe(0);
    sfx.listen({ x: 300, y: 0 });
    expect(long?.volume()).toBeGreaterThan(0);
    expect(long?.volume()).toBeLessThan(1);
  });

  test("is heard from where it was made, wherever the point it was made at goes", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);
    const maker = { x: 0, y: 0 };
    void sfx.play("long.mp3", maker, { x: 0, y: 0 }, { range: 400 });
    await settle();
    maker.x = 1000;
    sfx.listen({ x: 0, y: 0 });
    expect(audio.sounds()[0]?.volume()).toBe(1);
  });

  test("is left alone once it ends or is stopped, as is one without a position", async () => {
    const audio = stubAudio();
    const sfx = createSfx(falloff);
    const near = { x: 0, y: 0 };
    void sfx.play("ended.mp3", near, near, { range: 400 });
    const stopping = sfx.play("stopped.mp3", near, near, { range: 400 });
    void sfx.play("everywhere.mp3", null, null);
    await settle();
    const [ended, stopped, everywhere] = audio.sounds();
    ended?.end();
    (await stopping).stop(0);

    sfx.listen({ x: 300, y: 0 });
    expect(ended?.volume()).toBe(1);
    expect(stopped?.volume()).toBe(0);
    expect(everywhere?.volume()).toBe(1);
  });
});
