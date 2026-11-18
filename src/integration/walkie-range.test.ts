import { expect, test } from "vitest";
import { itemContent } from "../items/index.js";
import {
  createPlayer,
  createSession,
  giveItem,
  onAir,
  registerContent,
  spawnWorldItem,
  updateSession,
  voiceRoutes,
} from "../sim/index.js";
import { routedMix } from "../voice/index.js";
import { idle } from "./crew.js";
import { testItemsConfig, testSfx, testSimConfig } from "./sim-config.js";

/*
 * Walkies carry across the whole map (#491): a transmission plays from a walkie however far it is
 * from the speaker, and on the shipped interference curve, mirrored here, it is still clearly
 * heard 100 cells off.
 */

const { cell } = testSimConfig.world;
const VOICE = {
  full: 100,
  silent: 600,
  pan: 300,
  radio: { full: cell, silent: cell * 8, pan: 300 },
  interference: {
    clear: cell * 6,
    lost: cell * 120,
    floor: 0.1,
    ceiling: 0.35,
  },
};
/** The most interference that still leaves speech clearly heard: dropouts stay rare below half. */
const CLEAR_ENOUGH = 0.4;

test("a transmission from 110 cells off plays from the walkie beside the listener, mildly broken up", () => {
  const game = createSession("me", "ME", "RANGE", "standard", testSfx(), {
    ...testSimConfig,
    world: { ...testSimConfig.world, cols: 130 },
  });
  registerContent(game, itemContent(testItemsConfig));
  expect(giveItem(game, "me", "walkie", 1, undefined, { on: true })).toBe(true);
  game.local.held = 1;
  updateSession(game, idle, 1 / 60);
  onAir.set(game.local, true);

  const speaker = { x: game.local.x, y: game.local.y };
  const listener = createPlayer(
    "far",
    "FAR",
    { x: speaker.x + cell * 110, y: speaker.y },
    testSimConfig,
  );
  game.players.set(listener.id, listener);
  const beside = { x: listener.x + cell / 2, y: listener.y };
  spawnWorldItem(game, beside, "walkie", undefined, { on: true });

  const routes = voiceRoutes(game, game.local, listener);
  expect(routes).toContainEqual({ at: beside, via: "radio", from: speaker });

  const mix = routedMix(listener, routes, VOICE);
  expect(mix.volume).toBe(0);
  expect(mix.radio?.volume).toBe(1);
  expect(mix.radio?.interference).toBeGreaterThan(VOICE.interference.floor);
  expect(mix.radio?.interference).toBeLessThanOrEqual(CLEAR_ENOUGH);
});

test("the interference rises with distance, stays mild at 100 cells, and tops out at its ceiling", () => {
  const curve = VOICE.interference;
  const at = (cells: number) =>
    routedMix(
      { x: 0, y: 0 },
      [{ at: { x: 0, y: 0 }, via: "radio", from: { x: cells * cell, y: 0 } }],
      VOICE,
    ).radio?.interference ?? Infinity;
  expect(at(1)).toBe(curve.floor);
  expect(at(50)).toBeLessThan(at(100));
  expect(at(100)).toBeLessThanOrEqual(CLEAR_ENOUGH);
  expect(at(1000)).toBe(curve.ceiling);
});
