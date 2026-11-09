import { createSfx } from "../audio/index.js";
import type { Sfx } from "../audio/index.js";
import type { MonsterConfig } from "../monsters/index.js";
import type { SimConfig } from "../sim/index.js";

/**
 * Tuning for tests that build a whole session. A full stamina bar lasts 3s of sprinting and
 * refills in 4s after a 0.6s rest.
 */
export const testSimConfig: SimConfig = {
  world: { cell: 50, cols: 80, rows: 60, seed: 7, wallBounce: 0 },
  view: { width: 900, height: 600 },
  player: {
    radius: 14,
    speed: 220,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    inventorySlots: 4,
    nameMax: 8,
  },
  stamina: { max: 90, drain: 30, regen: 22.5, regenDelay: 0.6, recover: 27 },
  vision: { coneAngle: Math.PI / 2, rays: 64, surroundingsRadius: 70 },
  light: { range: 200 },
  net: { smoothing: 12 },
};

/** Three chasers, which walk at 50px/s, chase at 200px/s and see 300px. */
export const testMonsterConfig: MonsterConfig = {
  chasers: 3,
  seed: 3,
  clearance: 400,
  chaser: {
    radius: 15,
    wanderSpeed: 50,
    chaseSpeed: 200,
    sightRange: 300,
    wanderRange: 200,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 25,
  },
};

/** Sound effects for sessions under test; nothing plays. */
export function testSfx(): Sfx {
  return createSfx({ full: 0, silent: 1000, pan: 500 });
}
