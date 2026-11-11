import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { receiveEvent } from "./content-event.js";
import { broadcastNoise } from "./noise.js";
import type { Controls } from "./player.js";
import { rippleRing } from "./ripples.js";
import type { Ripple } from "./ripples.js";
import { applyRemoteState, createSession, updateSession } from "./session.js";
import type { Session } from "./session.js";

const DT = 1 / 60;
const { ripples: config, footsteps } = testSimConfig;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
};
const walking: Controls = { ...idle, move: { x: 1, y: 0 } };

/** The dev square, its local player in the open at (100, 300). */
function session(): Session {
  const game = createSession(
    "me",
    "ME",
    "RIPPLE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  return game;
}

function steps(game: Session, controls: Controls, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, controls, DT);
}

/** A remote player at `x` along the local player's row, walking. */
function walkerAt(game: Session, x: number): void {
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    x,
    y: 300,
    aim: 0,
    health: 100,
    content: { "core/movement": { mode: "walk", moving: true } },
  });
}

describe("footstep ripples", () => {
  test("the local player sees its own footsteps, clear and where it stands", () => {
    const game = session();
    updateSession(game, walking, DT);
    expect(game.ripples.list).toEqual([
      {
        at: { x: game.local.x, y: 300 },
        clarity: 1,
        loudness: footsteps.walk.loudness,
        startedAt: game.time,
      },
    ]);
  });

  test("a remote player's footsteps ripple within hearing range, with no event sent", () => {
    const game = session();
    game.hosting = false;
    const distance = config.hearingRange * footsteps.walk.loudness * 0.5;
    walkerAt(game, 100 + distance);
    updateSession(game, idle, DT);
    const [ripple] = game.ripples.list;
    expect(game.ripples.list).toHaveLength(1);
    expect(ripple?.clarity).toBeCloseTo(0.5);
    expect(
      Math.hypot(
        (ripple?.at.x ?? 0) - 100 - distance,
        (ripple?.at.y ?? 0) - 300,
      ),
    ).toBeLessThanOrEqual(distance * testSimConfig.noise.blur);
    expect(game.outbox).toEqual([]);
  });

  test("footsteps beyond hearing range make no ripple", () => {
    const game = session();
    walkerAt(game, 100 + config.hearingRange * footsteps.walk.loudness + 10);
    steps(game, idle, 1);
    expect(game.ripples.list).toEqual([]);
  });

  test("a ripple lasts its duration, then is dropped", () => {
    const game = session();
    updateSession(game, walking, DT);
    const [first] = game.ripples.list;
    steps(game, idle, config.duration - 2 * DT);
    expect(game.ripples.list).toEqual([first]);
    steps(game, idle, 3 * DT);
    expect(game.ripples.list).toEqual([]);
  });
});

describe("noise from the host", () => {
  const made = (game: Session, from: string) => {
    const [outgoing] = game.outbox.splice(0);
    if (outgoing === undefined) throw new Error("nothing sent");
    receiveEvent(game, { ...outgoing, from }, "host");
  };

  test("is sent once to everyone, and made and heard on a client that takes its sender for the host", () => {
    const sender = session();
    broadcastNoise(sender, { at: { x: 200, y: 300 }, loudness: 1 });
    expect(sender.outbox).toEqual([
      {
        content: "core/noise",
        event: "made",
        route: "all",
        to: null,
        payload: { x: 200, y: 300, loudness: 1, source: null },
      },
    ]);

    const game = session();
    game.outbox.push(...sender.outbox);
    made(game, "host");
    updateSession(game, idle, DT);
    expect(game.noises).toEqual([{ at: { x: 200, y: 300 }, loudness: 1 }]);
    expect(game.ripples.list).toEqual([
      expect.objectContaining({ clarity: 1 - 100 / config.hearingRange }),
    ]);
  });

  test("keeps its source", () => {
    const game = session();
    broadcastNoise(game, { at: { x: 200, y: 300 }, loudness: 1, source: "e1" });
    made(game, "host");
    updateSession(game, idle, DT);
    expect(game.noises).toEqual([
      { at: { x: 200, y: 300 }, loudness: 1, source: "e1" },
    ]);
  });

  test("is dropped when it comes from anyone else", () => {
    const game = session();
    broadcastNoise(game, { at: { x: 200, y: 300 }, loudness: 1 });
    made(game, "someone");
    updateSession(game, idle, DT);
    expect(game.noises).toEqual([]);
    expect(game.ripples.list).toEqual([]);
  });
});

describe("a ripple's ring", () => {
  const ripple = (clarity: number, loudness = 1): Ripple => ({
    at: { x: 0, y: 0 },
    clarity,
    loudness,
    startedAt: 10,
  });

  test("spreads out as it fades, and is gone outside its duration", () => {
    const early = rippleRing(ripple(1), 10.1, config);
    const late = rippleRing(ripple(1), 10 + config.duration * 0.9, config);
    expect(late?.radius).toBeGreaterThan(early?.radius ?? Infinity);
    expect(late?.alpha).toBeLessThan(early?.alpha ?? 0);
    expect(rippleRing(ripple(1), 9.9, config)).toBeNull();
    expect(rippleRing(ripple(1), 10 + config.duration, config)).toBeNull();
  });

  test("a noise heard less clearly is drawn thicker and fainter", () => {
    const near = rippleRing(ripple(1), 10.1, config);
    const far = rippleRing(ripple(0.2), 10.1, config);
    expect(far?.width).toBeGreaterThan(near?.width ?? Infinity);
    expect(far?.alpha).toBeLessThan(near?.alpha ?? 0);
  });

  test("a louder noise spreads further", () => {
    const at = 10 + config.duration / 2;
    const quiet = rippleRing(ripple(1, 0.2), at, config);
    const loud = rippleRing(ripple(1, 1.5), at, config);
    expect(loud?.radius).toBeGreaterThan(quiet?.radius ?? Infinity);
  });
});
