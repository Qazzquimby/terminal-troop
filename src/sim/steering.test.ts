import { expect, test } from "vitest";
import { idle } from "../integration/crew.js";
import { entryOf, reportedAt } from "../integration/heard.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { receiveEvent } from "./content-event.js";
import type { Controls, Player } from "./player.js";
import type { Session } from "./session.js";
import { createSession, updateSession } from "./session.js";
import { applyPlayerEntries } from "./steering.js";

const DT = 1 / 60;
const START = { x: 300, y: 300 };

/** A host with a remote player `g` standing at START. */
function host(): { game: Session; guest: Player } {
  const game = createSession(
    "h",
    "H",
    "STEER",
    "dev",
    testSfx(),
    testSimConfig,
  );
  game.local.x = 700;
  game.local.y = 500;
  return { game, guest: reportedAt(game, "g", START) };
}

/** Hands the host `g`'s steer, starting on its step `step`. */
function steer(game: Session, step: number, move: { x: number; y: number }) {
  receiveEvent(
    game,
    {
      from: "g",
      to: null,
      content: "core/steering",
      event: "steer",
      payload: { step, move, sprint: false, held: null },
    },
    game.localId,
  );
}

const run = (game: Session, steps: number, controls: Controls = idle) => {
  for (let i = 0; i < steps; i++) updateSession(game, controls, DT);
};

test("a steer that arrives after the host ran its step is run from that step: the player ends as if it had come in time", () => {
  const late = host();
  const timely = host();
  for (const { game } of [late, timely]) steer(game, 10, { x: 1, y: 0 });
  steer(timely.game, 20, { x: 0, y: 1 });
  run(late.game, 30);
  run(timely.game, 30);
  expect(late.game.feeds.get("g")?.label).toBeGreaterThan(20);
  steer(late.game, 20, { x: 0, y: 1 });
  run(late.game, 1);
  // The late host waits as many steps as the steer was late, so the next ones arrive in time.
  expect(late.game.feeds.get("g")?.wait).toBeGreaterThan(0);
  expect(late.game.feeds.get("g")?.label).toBe(
    timely.game.feeds.get("g")?.label,
  );
  expect({ x: late.guest.x, y: late.guest.y }).toEqual({
    x: timely.guest.x,
    y: timely.guest.y,
  });
  expect(late.guest.y).toBeGreaterThan(START.y);
});

test("a steer from further back than the host keeps picks up from where the player is", () => {
  const { game, guest } = host();
  steer(game, 10, { x: 1, y: 0 });
  run(game, 120);
  const label = game.feeds.get("g")?.label ?? NaN;
  steer(game, label - 60, { x: 0, y: 0 });
  const at = guest.x;
  run(game, 1);
  expect(game.feeds.get("g")?.label).toBe(label - 60);
  // It slows from where it was rather than going back.
  expect(guest.x).toBeGreaterThan(at);
});

test("a steer far ahead of the host's run of its player has the host run its steps to catch up", () => {
  const { game } = host();
  steer(game, 10, { x: 1, y: 0 });
  run(game, 10);
  steer(game, 200, { x: 0, y: 0 });
  run(game, 1);
  expect(game.feeds.get("g")?.label).toBe(200);
});

/** A guest `g` at START that has walked right for `steps` steps of its own. */
function guest(steps: number): Session {
  const game = createSession(
    "g",
    "G",
    "STEER",
    "dev",
    testSfx(),
    testSimConfig,
  );
  game.hosting = false;
  Object.assign(game.local, { ...START, prevX: START.x, prevY: START.y });
  run(game, steps, { ...idle, move: { x: 1, y: 0 } });
  return game;
}

test("a guest that ran a step as the host did keeps going, uncorrected", () => {
  const game = guest(20);
  const host = guest(10);
  const at = { x: game.local.x, y: game.local.y };
  applyPlayerEntries(
    game,
    [
      entryOf("g", host.local, {
        step: 10,
        vx: host.local.vx,
        vy: host.local.vy,
        stamina: host.local.stamina,
        steer: { move: { x: 1, y: 0 }, sprint: false, held: 0 },
      }),
    ],
    () => true,
  );
  expect(game.corrections.count).toBe(0);
  expect({ x: game.local.x, y: game.local.y }).toEqual(at);
});
