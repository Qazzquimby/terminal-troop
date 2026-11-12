import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { applyEntityChanges, registerEntityType } from "./entities.js";
import type { WorldEntity } from "./entities.js";
import {
  confirmAction,
  handledActions,
  nextAction,
  predict,
} from "./prediction.js";
import { applyRemoteState, createSession, updateSession } from "./session.js";
import type { Session } from "./session.js";
import type { Controls } from "./player.js";
import { applyWorldEntries, takeWorldEntries } from "./world-data.js";

const DT = 1 / 60;
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

/** A guest's session holding one still post at (300, 300) with 10 health, as its host sent it. */
function guest(): { game: Session; post: WorldEntity } {
  const game = createSession("me", "ME", "PREDICT", "dev", testSfx(), {
    ...testSimConfig,
  });
  registerEntityType(game, "post", {
    radius: 10,
    maxHealth: 10,
    data: z.object({}),
    draw: () => undefined,
  });
  game.hosting = false;
  applyEntityChanges(game, {
    added: [{ id: "h:1", kind: 1, x: 300, y: 300, health: 10, data: {} }],
    changed: [],
    removed: [],
  });
  const post = game.entities.get("h:1");
  if (post === undefined) throw new Error("no post");
  return { game, post };
}

/** A hit that moves `entity` 50px right and takes 4 health. */
const hit = (entity: WorldEntity): void => {
  entity.x += 50;
  entity.health -= 4;
};

/** The host's snapshot of the post at `x` with `health`. */
const hear = (game: Session, x: number, health: number): void => {
  applyEntityChanges(game, {
    added: [],
    changed: [{ id: "h:1", x, health }],
    removed: [],
  });
};

test("actions are numbered from 1", () => {
  const { game } = guest();
  expect([nextAction(game), nextAction(game)]).toEqual([1, 2]);
});

test("a guest's prediction holds against the host until the host has handled the action", () => {
  const { game, post } = guest();
  const action = nextAction(game);
  predict(game, action, [post], hit);
  expect(post).toMatchObject({ x: 350, health: 6 });
  hear(game, 300, 10);
  updateSession(game, idle, DT);
  expect(post).toMatchObject({ x: 350, health: 6 });

  const host = createSession("h", "H", "PREDICT", "dev", testSfx(), {
    ...testSimConfig,
  });
  applyRemoteState(host, {
    id: "me",
    name: "ME",
    x: 100,
    y: 100,
    aim: 0,
    epoch: 0,
    content: {},
  });
  confirmAction(host, "me", action);
  hear(game, 340, 6);
  applyWorldEntries(
    game,
    { host: "h", term: 1 },
    takeWorldEntries(host, false) ?? {},
  );
  updateSession(game, idle, DT);
  expect(game.predictions.size).toBe(0);
  expect(post.health).toBe(6);
  expect(post.x).toBeLessThan(350);
  expect(post.x).toBeGreaterThan(340);
});

test("the host forgets players who have left as it confirms another's action", () => {
  const host = createSession("h", "H", "PREDICT", "dev", testSfx(), {
    ...testSimConfig,
  });
  confirmAction(host, "gone", 3);
  confirmAction(host, "h", 1);
  expect(handledActions.get(host)).toEqual({ h: 1 });
});

test("the host predicts nothing, and a guest that takes over lets go, where it drew each entity and at the health last heard", () => {
  const { game, post } = guest();
  game.hosting = true;
  predict(game, nextAction(game), [post], hit);
  expect(post).toMatchObject({ x: 300, health: 10 });

  game.hosting = false;
  predict(game, nextAction(game), [post], hit);
  hear(game, 300, 10);
  game.hosting = true;
  updateSession(game, idle, DT);
  expect(game.predictions.size).toBe(0);
  expect(post).toMatchObject({ x: 350, health: 10 });
});
