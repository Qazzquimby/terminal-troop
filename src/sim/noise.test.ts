import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { mulberry32 } from "./map.js";
import { emitNoise, noisesHeardBy } from "./noise.js";
import { createSession, updateSession } from "./session.js";

const { blur } = testSimConfig.noise;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

const session = () =>
  createSession("me", "ME", "NOISE", "dev", testSfx(), testSimConfig);

/** Hears at (0, 0), drawing its blur from a generator seeded by `seed`. */
const listener = (seed = 1) => ({
  at: { x: 0, y: 0 },
  rng: mulberry32(seed),
});

describe("hearing", () => {
  test("a listener hears a noise whose radius reaches it, with its source and radius", () => {
    const game = session();
    emitNoise(game, { at: { x: 100, y: 0 }, radius: 300, source: "them" });
    expect(noisesHeardBy(game, listener())).toEqual([
      expect.objectContaining({
        source: "them",
        radius: 300,
        clarity: 1 - 100 / 300,
      }),
    ]);
  });

  test("a noise is heard out to its radius and no further", () => {
    const game = session();
    emitNoise(game, { at: { x: 400, y: 0 }, radius: 399 });
    emitNoise(game, { at: { x: 0, y: 400 }, radius: 400 });
    emitNoise(game, { at: { x: 100, y: 0 }, radius: 0 });
    expect(noisesHeardBy(game, listener())).toEqual([
      expect.objectContaining({ source: null, radius: 400, clarity: 0 }),
    ]);
  });

  test("a noise is clear close by and faint towards the edge of its radius", () => {
    const game = session();
    for (const x of [0, 100, 250, 380])
      emitNoise(game, { at: { x, y: 0 }, radius: 400 });
    const clarity = noisesHeardBy(game, listener()).map(
      (h) => Math.round(h.clarity * 1000) / 1000,
    );
    expect(clarity).toEqual([1, 0.75, 0.375, 0.05]);
  });

  test("a noise is heard only in the step it is made in", () => {
    const game = session();
    emitNoise(game, { at: { x: 100, y: 0 }, radius: 300 });
    updateSession(game, idle, 1 / 60);
    expect(noisesHeardBy(game, listener())).toEqual([]);
  });
});

describe("blur", () => {
  /** How far a noise `distance` off seems from where it was made, by `samples` listeners. */
  const strays = (distance: number, samples = 200): number[] => {
    const game = session();
    emitNoise(game, { at: { x: distance, y: 0 }, radius: 3000 });
    return Array.from({ length: samples }, (_, seed) => {
      const [heard] = noisesHeardBy(game, listener(seed));
      if (heard === undefined) throw new Error("not heard");
      return Math.hypot(heard.at.x - distance, heard.at.y);
    });
  };

  test("a noise where the listener stands is heard exactly", () => {
    expect(Math.max(...strays(0))).toBe(0);
  });

  test("strays no further than the blur of its distance, and further the further off it is", () => {
    const near = strays(100);
    const far = strays(1000);
    expect(Math.max(...near)).toBeLessThanOrEqual(100 * blur);
    expect(Math.max(...far)).toBeLessThanOrEqual(1000 * blur);
    expect(Math.max(...far)).toBeGreaterThan(Math.max(...near) * 5);
  });

  test("the same seed hears a noise in the same spot", () => {
    const game = session();
    emitNoise(game, { at: { x: 500, y: 0 }, radius: 3000 });
    expect(noisesHeardBy(game, listener(7))).toEqual(
      noisesHeardBy(game, listener(7)),
    );
    expect(noisesHeardBy(game, listener(7))).not.toEqual(
      noisesHeardBy(game, listener(8)),
    );
  });
});
