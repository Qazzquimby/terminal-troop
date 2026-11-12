import { describe, expect, test } from "vitest";
import {
  testRippleConfig as config,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  applyRemoteState,
  broadcastNoise,
  createSession,
  mulberry32,
  receiveEvent,
  updateSession,
} from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createRipples, rippleRing } from "./ripples.js";
import type { Ripple, Ripples } from "./ripples.js";

const DT = 1 / 60;
const { footsteps } = testSimConfig;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};
const walking: Controls = { ...idle, move: { x: 1, y: 0 } };

/** The dev square, its local player in the open at (100, 300), and no ripples yet. */
function session(): { game: Session; ripples: Ripples } {
  const game = createSession(
    "me",
    "ME",
    "RIPPLE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  return { game, ripples: createRipples(config, mulberry32(1)) };
}

/** Runs one step, then hears it as a frame does, with sim time as the frame clock. */
function step(game: Session, ripples: Ripples, controls: Controls): void {
  updateSession(game, controls, DT);
  ripples.hear(game, game.time * 1000);
}

function steps(
  game: Session,
  ripples: Ripples,
  controls: Controls,
  seconds: number,
): void {
  for (let i = 0; i < Math.round(seconds / DT); i++)
    step(game, ripples, controls);
}

/** A remote player at `x` along the local player's row, walking or in another gait. */
function walkerAt(
  game: Session,
  x: number,
  mode: "walk" | "sprint" = "walk",
): void {
  applyRemoteState(game, {
    id: "them",
    name: "THEM",
    x,
    y: 300,
    aim: 0,
    health: 100,
    content: { "core/movement": { mode, moving: true } },
  });
}

describe("footstep ripples", () => {
  test("the local player sees its own footsteps, clear and where it stands", () => {
    const { game, ripples } = session();
    step(game, ripples, walking);
    expect(ripples.list).toEqual([
      {
        at: { x: game.local.x, y: 300 },
        clarity: 1,
        radius: footsteps.walk.radius,
        startedAt: game.time * 1000,
      },
    ]);
  });

  test("a remote player's footsteps ripple within their radius, with no event sent", () => {
    const { game, ripples } = session();
    game.hosting = false;
    const distance = footsteps.walk.radius * 0.5;
    walkerAt(game, 100 + distance);
    step(game, ripples, idle);
    const [ripple] = ripples.list;
    expect(ripples.list).toHaveLength(1);
    expect(ripple?.clarity).toBeCloseTo(0.5);
    expect(
      Math.hypot(
        (ripple?.at.x ?? 0) - 100 - distance,
        (ripple?.at.y ?? 0) - 300,
      ),
    ).toBeLessThanOrEqual(distance * testSimConfig.noise.blur);
    expect(game.outbox).toEqual([]);
  });

  test("the local player sees only the footsteps whose radius reaches it", () => {
    const { game, ripples } = session();
    const beyondWalk = 100 + footsteps.walk.radius + 10;
    walkerAt(game, beyondWalk);
    steps(game, ripples, idle, 1);
    expect(ripples.list).toEqual([]);

    expect(footsteps.sprint.radius).toBeGreaterThan(beyondWalk - 100);
    walkerAt(game, beyondWalk, "sprint");
    steps(game, ripples, idle, footsteps.sprint.interval);
    expect(ripples.list).toEqual([
      expect.objectContaining({ radius: footsteps.sprint.radius }),
    ]);
  });

  test("a ripple lasts its duration, then is dropped", () => {
    const { game, ripples } = session();
    step(game, ripples, walking);
    const [first] = ripples.list;
    steps(game, ripples, idle, config.duration - 2 * DT);
    expect(ripples.list).toEqual([first]);
    steps(game, ripples, idle, 3 * DT);
    expect(ripples.list).toEqual([]);
  });

  test("each step's noises are heard once, at that step's time, and clearing drops them", () => {
    const { game, ripples } = session();
    walkerAt(game, 150);
    const stepsPerFootstep = Math.round(footsteps.walk.interval / DT);
    for (let i = 0; i <= stepsPerFootstep + 1; i++) {
      updateSession(game, i === 0 ? walking : idle, DT);
      ripples.hear(game, 1000 + i);
    }
    const [mine, theirs, next] = ripples.list.map((ripple) => ripple.startedAt);
    expect(ripples.list).toHaveLength(3);
    expect([mine, theirs]).toEqual([1000, 1000]);
    expect(next).toBeGreaterThanOrEqual(1000 + stepsPerFootstep);
    ripples.clear();
    expect(ripples.list).toEqual([]);
  });
});

describe("noise from the host", () => {
  const made = (game: Session, from: string) => {
    const [outgoing] = game.outbox.splice(0);
    if (outgoing === undefined) throw new Error("nothing sent");
    receiveEvent(game, { ...outgoing, from }, "host");
  };

  test("is sent once to everyone, and made and heard on a client that takes its sender for the host", () => {
    const { game: sender } = session();
    broadcastNoise(sender, { at: { x: 200, y: 300 }, radius: 300 });
    expect(sender.outbox).toEqual([
      {
        content: "core/noise",
        event: "made",
        route: "all",
        to: null,
        payload: { x: 200, y: 300, radius: 300, source: null },
      },
    ]);

    const { game, ripples } = session();
    game.outbox.push(...sender.outbox);
    made(game, "host");
    step(game, ripples, idle);
    expect(game.noises).toEqual([{ at: { x: 200, y: 300 }, radius: 300 }]);
    expect(ripples.list).toEqual([
      expect.objectContaining({ clarity: 1 - 100 / 300, radius: 300 }),
    ]);
  });

  test("keeps its source", () => {
    const { game } = session();
    broadcastNoise(game, { at: { x: 200, y: 300 }, radius: 300, source: "e1" });
    made(game, "host");
    updateSession(game, idle, DT);
    expect(game.noises).toEqual([
      { at: { x: 200, y: 300 }, radius: 300, source: "e1" },
    ]);
  });

  test("is dropped when it comes from anyone else", () => {
    const { game, ripples } = session();
    broadcastNoise(game, { at: { x: 200, y: 300 }, radius: 300 });
    made(game, "someone");
    step(game, ripples, idle);
    expect(game.noises).toEqual([]);
    expect(ripples.list).toEqual([]);
  });
});

describe("a ripple's ring", () => {
  const ripple = (clarity: number, radius = 100): Ripple => ({
    at: { x: 0, y: 0 },
    clarity,
    radius,
    startedAt: 10_000,
  });
  const ms = (seconds: number): number => seconds * 1000;

  test("spreads out as it fades, and is gone outside its duration", () => {
    const early = rippleRing(ripple(1), ms(10.1), config);
    const late = rippleRing(ripple(1), ms(10 + config.duration * 0.9), config);
    expect(late?.radius).toBeGreaterThan(early?.radius ?? Infinity);
    expect(late?.alpha).toBeLessThan(early?.alpha ?? 0);
    expect(rippleRing(ripple(1), ms(9.9), config)).toBeNull();
    expect(rippleRing(ripple(1), ms(10 + config.duration), config)).toBeNull();
  });

  test("a noise heard less clearly is drawn thicker and fainter", () => {
    const near = rippleRing(ripple(1), ms(10.1), config);
    const far = rippleRing(ripple(0.2), ms(10.1), config);
    expect(far?.width).toBeGreaterThan(near?.width ?? Infinity);
    expect(far?.alpha).toBeLessThan(near?.alpha ?? 0);
  });

  test("grows out to the noise's radius and no further", () => {
    const radii = [0.25, 0.5, 0.75, 0.999].map(
      (t) =>
        rippleRing(ripple(1, 400), ms(10 + config.duration * t), config)
          ?.radius,
    );
    expect(radii.every((r) => r !== undefined && r <= 400)).toBe(true);
    expect(radii.at(-1)).toBeCloseTo(400, 1);
  });
});
