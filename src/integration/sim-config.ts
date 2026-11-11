import { createSfx } from "../audio/index.js";
import type { Sfx } from "../audio/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import type { ItemsConfig } from "../items/index.js";
import type { MovesConfig } from "../moves/index.js";
import type { MapMemoryConfig, RippleConfig } from "../render/index.js";
import type { SimConfig } from "../sim/index.js";

/**
 * Tuning for tests that build a whole session. A full stamina bar lasts 3s of sprinting and
 * refills in 4s after a 0.6s rest. A noise seems to come from within a fifth of its distance of
 * where it was made. Walking steps every 0.5s at loudness 0.5; sprinting every 0.25s at 1.5;
 * crouching, at half speed, every 0.75s at 0.2.
 */
export const testSimConfig: SimConfig = {
  world: { cell: 50, cols: 80, rows: 60, seed: 7, wallBounce: 0 },
  view: { width: 900, height: 600 },
  player: {
    radius: 14,
    speed: 220,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    crouchMultiplier: 0.5,
    inventorySlots: 4,
    maxHealth: 100,
    nameMax: 8,
  },
  stamina: { max: 90, drain: 30, regen: 22.5, regenDelay: 0.6, recover: 27 },
  vision: { coneAngle: Math.PI / 2, rays: 64, surroundingsRadius: 70 },
  light: { range: 200 },
  net: { smoothing: 12, useSlack: { distance: 40, seconds: 0.1 } },
  noise: { blur: 0.2 },
  footsteps: {
    walk: { interval: 0.5, loudness: 0.5 },
    sprint: { interval: 0.25, loudness: 1.5 },
    crouch: { interval: 0.75, loudness: 0.2 },
  },
};

/** The local player hears a noise of loudness 1 from 300px, and sees it ripple for 0.5s. */
export const testRippleConfig: RippleConfig = {
  hearingRange: 300,
  duration: 0.5,
  radius: { min: 10, perLoudness: 50 },
  width: { sharp: 2, soft: 10 },
  alpha: { sharp: 1, soft: 0.2 },
  colour: "#fff",
};

/** Remembered terrain is saved at most once a second, for the three worlds entered last. */
export const testMapMemoryConfig: MapMemoryConfig = {
  saveInterval: 1,
  maxRooms: 3,
  floor: { fill: "#111", grid: "#222", alpha: 0.5 },
  wall: { fill: "#333", edge: "#444", alpha: 0.5 },
};

/**
 * Three chasers in the 4000x3000 test world, two in the dev square; they walk at 50px/s, chase at
 * 200px/s, see 300px, have 40 health, bark every 4 to 8 seconds, and hit for 25 at most every 1.5
 * seconds, and hear a noise of loudness 1 from 300px. A cruiser starts 60px right of the first host, lighting 400px round it.
 */
export const testEntitiesConfig: EntitiesConfig = {
  chaser: {
    spawn: { count: { density: 0.25, min: 2 }, seed: 3, clearance: 400 },
    radius: 15,
    maxHealth: 40,
    attackDamage: 25,
    wanderSpeed: 50,
    chaseSpeed: 200,
    sightRange: 300,
    wanderRange: 200,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 25,
    barkGap: { min: 4, max: 8 },
    attackRange: 32,
    attackCooldown: 1.5,
    hearingRange: 300,
  },
  cruiser: { lightRadius: 400, offset: 60 },
};

/** Items: a shovel that hits 40px ahead for 25, so a test chaser falls to its second hit, at most twice a second. */
export const testItemsConfig: ItemsConfig = {
  shovel: {
    radius: 20,
    reach: 40,
    damage: 25,
    knockback: 20,
    cooldown: 0.5,
    duration: 0.1,
    volume: 1,
    hitLoudness: 1,
  },
};

/**
 * Moves: a kick that lunges one body length and hits 30px ahead of where it lands for 10, so a
 * test chaser falls to its fourth, sending what it hits two of its own body lengths away. It costs
 * a third of the test stamina bar, at most twice a second.
 */
export const testMovesConfig: MovesConfig = {
  kick: {
    reach: 30,
    radius: 20,
    damage: 10,
    knockback: 2,
    cooldown: 0.5,
    stamina: 30,
    lunge: { lengths: 1, seconds: 0.1 },
    duration: 0.1,
    loudness: 1,
  },
};

/** Sound effects for sessions under test; nothing plays. */
export function testSfx(): Sfx {
  return createSfx({ full: 0, silent: 1000, pan: 500 });
}
