import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import type { Noise } from "./noise.js";
import type { Controls } from "./player.js";
import { applyRemoteState, createSession, updateSession } from "./session.js";
import type { Session } from "./session.js";
import { speak, voiceNoise, voiceRadius } from "./voice-noise.js";

const DT = 1 / 60;
const config = testSimConfig.voiceNoise;
const { quiet, loud } = config.radius;

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

function session(): Session {
  const game = createSession(
    "me",
    "ME",
    "VOICE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 100, y: 300 });
  return game;
}

/** Every noise made over `seconds` of steps, the mic going out at `level` (or as it says) each step. */
function noisesOver(
  game: Session,
  level: number | ((time: number) => number),
  seconds: number,
): Noise[] {
  const made: Noise[] = [];
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    speak(game, typeof level === "number" ? level : level(game.time));
    updateSession(game, still, DT);
    made.push(...game.noises);
  }
  return made;
}

describe("how far speech carries", () => {
  test("below the threshold it makes no noise", () => {
    expect(voiceRadius(0, config)).toBe(0);
    expect(voiceRadius(config.threshold - 0.01, config)).toBe(0);
  });

  test("from the threshold it carries the quiet radius, growing to the loud one at full", () => {
    expect(voiceRadius(config.threshold, config)).toBe(quiet);
    expect(voiceRadius((config.threshold + config.full) / 2, config)).toBe(
      (quiet + loud) / 2,
    );
    expect(voiceRadius(config.full, config)).toBe(loud);
  });

  test("louder than full carries no further", () => {
    expect(voiceRadius(1, config)).toBe(loud);
  });

  test("comes in whole steps", () => {
    const radius = voiceRadius(config.threshold + 0.07, config);
    expect(radius % config.step).toBe(0);
    expect(radius).toBeGreaterThan(quiet);
  });
});

describe("the local player's speech", () => {
  test("is judged by its loudest level over the window", () => {
    const game = session();
    speak(game, 0.9);
    updateSession(game, still, DT);
    noisesOver(game, 0.4, config.window - 2 * DT);
    expect(voiceNoise.get(game.local)).toBe(loud);

    noisesOver(game, 0.4, 3 * DT);
    expect(voiceNoise.get(game.local)).toBe(voiceRadius(0.4, config));
  });

  test("a silent mic, as when muted or push-to-talk is let go, makes no noise", () => {
    const game = session();
    noisesOver(game, 1, 1);
    expect(noisesOver(game, 0, config.window + DT).length).toBeGreaterThan(0);
    expect(voiceNoise.get(game.local)).toBe(0);
    expect(noisesOver(game, 0, 2)).toEqual([]);
  });

  test("makes a noise as it starts to carry, then one each interval, from where the player stands", () => {
    const game = session();
    const made = noisesOver(game, 1, 2);
    expect(made).toHaveLength(Math.ceil(2 / config.interval));
    expect(made[0]).toEqual({
      at: { x: 100, y: 300 },
      radius: loud,
      source: "me",
    });
  });

  test("keeps its cadence through the gaps between words", () => {
    const game = session();
    const speech = (time: number): number => (time % 0.3 < 0.15 ? 0.9 : 0);
    expect(noisesOver(game, speech, 2)).toHaveLength(
      Math.ceil(2 / config.interval),
    );
  });
});

test("a remote player's reported speech makes its noise on this client", () => {
  const game = session();
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    x: 300,
    y: 300,
    aim: 0,
    epoch: 0,
    content: { "core/voice": loud },
  });
  const made = noisesOver(game, 0, 1);
  expect(made).toHaveLength(Math.ceil(1 / config.interval));
  expect(made.every((noise) => noise.source === "them")).toBe(true);
  expect(made[0]?.radius).toBe(loud);
});
