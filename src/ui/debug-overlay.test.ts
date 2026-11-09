import { expect, test } from "vitest";
import { createSfx } from "../audio/audio.js";
import { createPlayer, createSession } from "../sim/index.js";
import { roomDebugInfo } from "./debug-overlay.js";

test("room info lists remote players with the age of their last update", () => {
  const game = createSession("me", "ME", "DEBUG", "dev", createSfx());
  const remote = createPlayer("them", "THEM", game.world);
  remote.lastSeen = 1000;
  game.players.set("them", remote);
  const rates = { sentPerS: 20, receivedPerS: 18 };

  expect(roomDebugInfo(game, 1250, rates)).toEqual({
    net: rates,
    playerCount: 2,
    remotes: [{ name: "THEM", ageMs: 250 }],
  });
});

test("alone in the room lists no remotes", () => {
  const game = createSession("me", "ME", "DEBUG", "dev", createSfx());
  expect(
    roomDebugInfo(game, 0, { sentPerS: 0, receivedPerS: 0 }).remotes,
  ).toEqual([]);
});
