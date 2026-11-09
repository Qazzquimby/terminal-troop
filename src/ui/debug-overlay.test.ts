import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import { roomDebugInfo } from "./debug-overlay.js";

test("room info lists remote players with the age of their last update", () => {
  const game = createSession(
    "me",
    "ME",
    "DEBUG",
    "dev",
    testSfx(),
    testSimConfig,
  );
  const remote = createPlayer("them", "THEM", game.world, game.config);
  game.players.set("them", remote);
  const rates = { sentPerS: 20, receivedPerS: 18 };

  const heard = new Map([["them", 1000]]);

  expect(roomDebugInfo(game, 1250, rates, (id) => heard.get(id))).toEqual({
    net: rates,
    playerCount: 2,
    remotes: [{ name: "THEM", ageMs: 250 }],
  });
});

test("alone in the room lists no remotes", () => {
  const game = createSession(
    "me",
    "ME",
    "DEBUG",
    "dev",
    testSfx(),
    testSimConfig,
  );
  expect(
    roomDebugInfo(game, 0, { sentPerS: 0, receivedPerS: 0 }, () => undefined)
      .remotes,
  ).toEqual([]);
});
