import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { mulberry32 } from "./map.js";
import { z } from "zod";
import { registerEntityType, spawnEntity } from "./entities.js";
import {
  emitNoise,
  kindTags,
  makeNoise,
  noisesHeardBy,
  PLAYER_TAG,
} from "./noise.js";
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
    emitNoise(game, {
      tags: [],
      at: { x: 100, y: 0 },
      radius: 300,
      source: "them",
    });
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
    emitNoise(game, { tags: [], at: { x: 400, y: 0 }, radius: 399 });
    emitNoise(game, { tags: [], at: { x: 0, y: 400 }, radius: 400 });
    emitNoise(game, { tags: [], at: { x: 100, y: 0 }, radius: 0 });
    expect(noisesHeardBy(game, listener())).toEqual([
      expect.objectContaining({ source: null, radius: 400, clarity: 0 }),
    ]);
  });

  test("a noise is clear close by and faint towards the edge of its radius", () => {
    const game = session();
    for (const x of [0, 100, 250, 380])
      emitNoise(game, { tags: [], at: { x, y: 0 }, radius: 400 });
    const clarity = noisesHeardBy(game, listener()).map(
      (h) => Math.round(h.clarity * 1000) / 1000,
    );
    expect(clarity).toEqual([1, 0.75, 0.375, 0.05]);
  });

  test("a noise is heard only in the step it is made in", () => {
    const game = session();
    emitNoise(game, { tags: [], at: { x: 100, y: 0 }, radius: 300 });
    updateSession(game, idle, 1 / 60);
    expect(noisesHeardBy(game, listener())).toEqual([]);
  });
});

describe("blur", () => {
  /** How far a noise `distance` off seems from where it was made, by `samples` listeners. */
  const strays = (distance: number, samples = 200): number[] => {
    const game = session();
    emitNoise(game, { tags: [], at: { x: distance, y: 0 }, radius: 3000 });
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
    emitNoise(game, { tags: [], at: { x: 500, y: 0 }, radius: 3000 });
    expect(noisesHeardBy(game, listener(7))).toEqual(
      noisesHeardBy(game, listener(7)),
    );
    expect(noisesHeardBy(game, listener(7))).not.toEqual(
      noisesHeardBy(game, listener(8)),
    );
  });
});

describe("tags", () => {
  test("a noise a player makes is tagged as a player's, then with how it was made", () => {
    const game = session();
    makeNoise(game, game.local, {
      at: { x: 10, y: 0 },
      radius: 100,
      tags: ["radio"],
    });
    expect(game.noises).toEqual([
      {
        at: { x: 10, y: 0 },
        radius: 100,
        source: "me",
        tags: [PLAYER_TAG, "radio"],
      },
    ]);
  });

  test("an entity is tagged with its kind's name; anything unknown, with nothing", () => {
    const game = session();
    registerEntityType(game, "bell", {
      radius: 10,
      maxHealth: 1,
      data: z.object({}),
      update: (_entity, data) => data,
      draw: () => undefined,
    });
    const bell = spawnEntity(game, "bell", 50, 50, {});
    expect(kindTags(game, bell.id)).toEqual(["bell"]);
    expect(kindTags(game, "me")).toEqual([PLAYER_TAG]);
    expect(kindTags(game, "nobody")).toEqual([]);
  });

  test("a listener hears each noise with its tags, and not those carrying a tag it ignores", () => {
    const game = session();
    emitNoise(game, { tags: ["bell"], at: { x: 10, y: 0 }, radius: 100 });
    emitNoise(game, {
      tags: [PLAYER_TAG, "voice"],
      at: { x: 20, y: 0 },
      radius: 100,
    });
    expect(noisesHeardBy(game, listener()).map(({ tags }) => tags)).toEqual([
      ["bell"],
      [PLAYER_TAG, "voice"],
    ]);
    const ignoring = { ...listener(), ignores: ["voice"] };
    expect(noisesHeardBy(game, ignoring).map(({ tags }) => tags)).toEqual([
      ["bell"],
    ]);
  });

  test("loudness is how far past the listener a noise still carries", () => {
    const game = session();
    emitNoise(game, { tags: [], at: { x: 100, y: 0 }, radius: 300 });
    emitNoise(game, { tags: [], at: { x: 900, y: 0 }, radius: 1100 });
    expect(noisesHeardBy(game, listener()).map((h) => h.loudness)).toEqual([
      200, 200,
    ]);
  });

  test("a heard noise keeps where it was really made, apart from where it seems to come from", () => {
    const game = session();
    emitNoise(game, { tags: [], at: { x: 500, y: 0 }, radius: 3000 });
    const [heard] = noisesHeardBy(game, listener(3));
    expect(heard?.origin).toEqual({ x: 500, y: 0 });
    expect(heard?.at).not.toEqual({ x: 500, y: 0 });
  });
});
