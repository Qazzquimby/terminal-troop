import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer } from "./player.js";
import type { Player } from "./player.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";
import { addVoiceChannel, onAir, voiceRoutes } from "./voice-routes.js";

/** A session, and a remote player 200px to the right of its local one. */
function setup(): { game: Session; them: Player } {
  const game = createSession(
    "me",
    "ME",
    "ROUTES",
    "dev",
    testSfx(),
    testSimConfig,
  );
  const them = createPlayer("them", "THEM", game.local, testSimConfig);
  them.x += 200;
  game.players.set(them.id, them);
  return { game, them };
}

test("with no channel, a voice reaches a listener through the air alone, from where its speaker stands", () => {
  const { game, them } = setup();
  expect(voiceRoutes(game, them, game.local)).toEqual([
    { at: { x: them.x, y: them.y }, via: "air" },
  ]);
});

test("each channel adds its routes after the air's, in the order they were added", () => {
  const { game, them } = setup();
  const speaker = { x: 5, y: 5 };
  addVoiceChannel(game, {
    routes: (_game, from) =>
      onAir.get(from) ? [{ at: speaker, via: "radio" }] : [],
  });
  addVoiceChannel(game, { routes: () => [{ at: null, via: "air" }] });
  expect(voiceRoutes(game, them, game.local).map((r) => r.at)).toEqual([
    { x: them.x, y: them.y },
    null,
  ]);
  onAir.set(them, true);
  expect(voiceRoutes(game, them, game.local)).toEqual([
    { at: { x: them.x, y: them.y }, via: "air" },
    { at: speaker, via: "radio" },
    { at: null, via: "air" },
  ]);
});

test("a channel that silences a speaker for a listener leaves it no route, the air's included", () => {
  const { game, them } = setup();
  addVoiceChannel(game, { routes: () => [{ at: null, via: "air" }] });
  addVoiceChannel(game, {
    routes: () => [],
    silences: (_game, speaker, listener) =>
      speaker.id === "them" && listener.id === "me",
  });
  expect(voiceRoutes(game, them, game.local)).toEqual([]);
  expect(voiceRoutes(game, game.local, them)).toHaveLength(2);
});

test("being on the air is the player's own to report, off until it says", () => {
  const { game } = setup();
  expect(onAir.get(game.local)).toBe(false);
  onAir.set(game.local, true);
  expect(onAir.get(game.local)).toBe(true);
});
