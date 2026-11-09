import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import { statusText } from "./status.js";

function session(remotes: number) {
  const game = createSession(
    "me",
    "ME",
    "ABC",
    "dev",
    testSfx(),
    testSimConfig,
  );
  for (let i = 0; i < remotes; i++) {
    const id = `r${String(i)}`;
    game.players.set(id, createPlayer(id, id, game.world, testSimConfig));
  }
  return game;
}

test("the lobby invites a room, or says why the last join failed", () => {
  expect(statusText({ kind: "lobby", error: null }, "local")).toBe(
    "Create or join a room to start.",
  );
  expect(statusText({ kind: "lobby", error: "No network." }, "local")).toBe(
    "No network.",
  );
});

test("connecting says so", () => {
  expect(statusText({ kind: "connecting", code: "ABC" }, "local")).toBe(
    "Connecting…",
  );
});

test("joined names the room, the transport and the player count", () => {
  expect(
    statusText(
      { kind: "joined", code: "ABC", session: session(0) },
      "supabase",
    ),
  ).toBe("Room ABC (supabase) · 1 player");
  expect(
    statusText({ kind: "joined", code: "ABC", session: session(2) }, "local"),
  ).toBe("Room ABC (local) · 3 players");
});
