import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import { roomDebugInfo } from "./debug-overlay.js";

function withRemote() {
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
  return game;
}

const rates = { sentPerS: 20, receivedPerS: 18 };

test("room info lists remote players with their presence and the age of their last message", () => {
  const heard = new Map([["them", { kind: "away", lastHeard: 1000 }]]);
  const room = {
    presenceOf: (id: string) => heard.get(id),
    hostId: () => "me",
  };

  expect(roomDebugInfo(withRemote(), 1250, rates, room)).toEqual({
    net: rates,
    playerCount: 2,
    host: "you",
    remotes: [{ name: "THEM", presence: "away", ageMs: 250 }],
  });
});

test("a remote host shows by name, or by id when it has no player yet", () => {
  const info = (hostId: string) =>
    roomDebugInfo(withRemote(), 0, rates, {
      presenceOf: () => undefined,
      hostId: () => hostId,
    }).host;
  expect(info("them")).toBe("THEM");
  expect(info("ghost")).toBe("ghost");
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
    roomDebugInfo(
      game,
      0,
      { sentPerS: 0, receivedPerS: 0 },
      { presenceOf: () => undefined, hostId: () => "me" },
    ).remotes,
  ).toEqual([]);
});
