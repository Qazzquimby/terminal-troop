import { describe, expect, test, vi } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { receiveEvent } from "./content-event.js";
import { createSession, updateSession } from "./session.js";
import { makeSound, sound } from "./sound.js";

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

const BANG = sound({ url: "bang.mp3", volume: 0.5, noise: 250 });
const CLICK = sound({ url: "click.mp3" });
const at = { x: 120, y: 80 };

function session() {
  const game = createSession(
    "me",
    "ME",
    "SOUND",
    "dev",
    testSfx(),
    testSimConfig,
  );
  const play = vi.spyOn(game.sfx, "play");
  return { game, play };
}

/** Hands each event the session sent back to it, as the room does while it hosts, and steps. */
function deliverOwn(game: ReturnType<typeof session>["game"]): void {
  for (const { content, event, to, payload } of game.outbox.splice(0))
    receiveEvent(
      game,
      { from: game.localId, to, content, event, payload },
      game.localId,
    );
  updateSession(game, idle, 1 / 60);
}

describe("making a sound", () => {
  test("plays it for this client's listener at its volume", () => {
    const { game, play } = session();
    makeSound(game, BANG, at);
    makeSound(game, CLICK, at);
    expect(play.mock.calls).toEqual([
      ["bang.mp3", at, game.local, { volume: 0.5 }],
      ["click.mp3", at, game.local, {}],
    ]);
  });

  test("on the host, a sound with a noise radius makes one noise, heard by the host too", () => {
    const { game } = session();
    makeSound(game, BANG, at, "them");
    expect(game.outbox).toHaveLength(1);
    deliverOwn(game);
    expect(game.noises).toEqual([{ at, radius: 250, source: "them" }]);
  });

  test("a sound without a noise radius makes no noise", () => {
    const { game } = session();
    makeSound(game, CLICK, at);
    expect(game.outbox).toEqual([]);
    deliverOwn(game);
    expect(game.noises).toEqual([]);
  });

  test("off the host, a sound plays but makes no noise", () => {
    const { game, play } = session();
    game.hosting = false;
    makeSound(game, BANG, at);
    expect(play).toHaveBeenCalledOnce();
    expect(game.outbox).toEqual([]);
  });
});
