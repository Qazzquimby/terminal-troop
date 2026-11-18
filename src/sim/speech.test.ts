import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { effect } from "./actions.js";
import { receiveEvent } from "./content-event.js";
import type { Noise } from "./noise.js";
import { createSession, updateSession } from "./session.js";
import type { Session } from "./session.js";
import { captionOf, MAX_LINE, voiceOf } from "./speech.js";
import type { Speech, SpokenLine } from "./speech.js";
import { VOICE_TAG } from "./voice-noise.js";

const { speech: config } = testSimConfig;

const IDLE = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};

/** A hosting session in the dev square whose speech records each line and each handle's fate. */
function world(): {
  game: Session;
  lines: SpokenLine[];
  stopped: () => number;
  moved: () => number;
} {
  const lines: SpokenLine[] = [];
  let stops = 0;
  let moves = 0;
  const speech: Speech = {
    say(line) {
      lines.push(line);
      return Promise.resolve({
        stop: () => {
          stops += 1;
        },
        setVolume: () => undefined,
        setPosition: () => {
          moves += 1;
        },
      });
    },
  };
  const game = createSession(
    "me",
    "ME",
    "TALK",
    "dev",
    testSfx(),
    testSimConfig,
    { at: { x: 425, y: 325 }, speech },
  );
  return { game, lines, stopped: () => stops, moved: () => moves };
}

/** Steps `seconds`, each event the host sends heard at once; the noises made. */
function run(game: Session, seconds: number): Noise[] {
  const heard: Noise[] = [];
  const dt = 1 / 60;
  for (let step = 0; step < Math.round(seconds / dt); step++) {
    for (const { content, event, to, payload } of game.outbox.splice(0))
      receiveEvent(
        game,
        { from: game.localId, to, content, event, payload },
        game.localId,
      );
    for (const { event, payload, sender } of game.inbox.splice(0))
      event.receive(game, payload, sender);
    heard.push(...game.noises);
    updateSession(game, IDLE, dt);
  }
  return heard;
}

test("a voice no config names is said in the fallback voice", () => {
  expect(voiceOf(config, "shout")).toBe(config.voices.shout);
  expect(voiceOf(config, "nobody")).toBe(config.voices.plain);
  expect(voiceOf(config, "toString")).toBe(config.voices.plain);
});

test("a line said in an effect is heard from its speaker in its voice, a voice's noise as far as the voice carries", async () => {
  const { game, lines, moved } = world();
  effect(
    game,
    { at: game.local, say: { text: "Hello there.", voice: "shout" } },
    game.local,
  );
  const heard = run(game, 0.1);
  expect(lines).toEqual([
    {
      text: "Hello there.",
      voice: config.voices.shout,
      at: { x: game.local.x, y: game.local.y },
      listener: game.local,
    },
  ]);
  expect(
    heard.some(
      (noise) =>
        noise.source === "me" &&
        noise.radius === config.voices.shout?.range &&
        noise.tags.includes(VOICE_TAG),
    ),
  ).toBe(true);
  // It follows its speaker as it goes on.
  await Promise.resolve();
  run(game, 0.1);
  expect(moved()).toBeGreaterThan(0);
});

test("a line shows over its speaker as long as it takes to say, and the hold after", () => {
  const { game } = world();
  const text = "Twenty letters long.";
  effect(game, { at: game.local, say: { text, voice: "plain" } }, game.local);
  run(game, 0.05);
  expect(captionOf(game, "me")).toBe(text);
  const rate = config.voices.plain?.rate ?? 1;
  run(game, text.length / rate + config.captionHold - 0.2);
  expect(captionOf(game, "me")).toBe(text);
  run(game, 0.3);
  expect(captionOf(game, "me")).toBeNull();
});

test("a speaker says one thing at a time: a new line stops the last", async () => {
  const { game, lines, stopped } = world();
  effect(
    game,
    { at: game.local, say: { text: "One.", voice: "plain" } },
    game.local,
  );
  run(game, 0.05);
  effect(
    game,
    { at: game.local, say: { text: "Two.", voice: "plain" } },
    game.local,
  );
  run(game, 0.05);
  await Promise.resolve();
  expect(lines.map(({ text }) => text)).toEqual(["One.", "Two."]);
  expect(stopped()).toBe(1);
  expect(captionOf(game, "me")).toBe("Two.");
});

test("a line too long to travel is cut short, not lost; an empty one says nothing", () => {
  const { game, lines } = world();
  effect(
    game,
    {
      at: game.local,
      say: { text: "a".repeat(MAX_LINE + 50), voice: "plain" },
    },
    game.local,
  );
  effect(
    game,
    { at: game.local, say: { text: "", voice: "plain" } },
    game.local,
  );
  run(game, 0.05);
  expect(lines.map(({ text }) => text.length)).toEqual([MAX_LINE]);
});
