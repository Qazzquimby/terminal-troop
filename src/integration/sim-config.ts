import { createSfx } from "../audio/index.js";
import type { Sfx } from "../audio/index.js";
import type { ShovelConfig } from "../items/index.js";
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
    maxHealth: 100,
    nameMax: 8,
  },
  stamina: { max: 90, drain: 30, regen: 22.5, regenDelay: 0.6, recover: 27 },
  vision: { coneAngle: Math.PI / 2, rays: 64, surroundingsRadius: 70 },
  light: { range: 200 },
  net: { smoothing: 12, useSlack: { distance: 40, seconds: 0.1 } },
};

/**
 * Three chasers in the 4000x3000 test world, two in the dev square; they walk at 50px/s, chase at
 * 200px/s, see 300px, have 40 health and hit for 25.
 */
export const testMonsterConfig: MonsterConfig = {
  chaserDensity: 0.25,
  minChasers: 2,
  seed: 3,
  clearance: 400,
  chaser: {
    radius: 15,
    maxHealth: 40,
    attackDamage: 25,
    wanderSpeed: 50,
    chaseSpeed: 200,
    sightRange: 300,
    wanderRange: 200,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 25,
  },
};

/** A shovel that hits 40px ahead for 25, so a test chaser falls to its second hit, at most twice a second. */
export const testShovelConfig: ShovelConfig = {
  radius: 20,
  reach: 40,
  damage: 25,
  knockback: 20,
  cooldownMs: 500,
  durationMs: 100,
};

/** Sound effects for sessions under test; nothing plays. */
export function testSfx(): Sfx {
  return createSfx({ full: 0, silent: 1000, pan: 500 });
}
