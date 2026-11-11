import type { SpatialFalloff } from "./audio/index.js";
import type { MonsterConfig } from "./monsters/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { ShovelConfig } from "./items/index.js";
import type { UiConfig } from "./ui/index.js";
import type { VoiceConnectionConfig, VoiceFalloff } from "./voice/index.js";

/** Every tunable, grouped by concern; each group has the shape its module declares. */
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
  readonly monsters: MonsterConfig;
  readonly shovel: ShovelConfig;
  readonly voice: VoiceFalloff;
  readonly voiceConnections: VoiceConnectionConfig;
  readonly audio: SpatialFalloff;
  readonly ui: UiConfig;
}

const CELL = 50;
const STAMINA_MAX = 100;

export const config = {
  world: { cell: CELL, cols: 160, rows: 120, seed: 1, wallBounce: 0 },
  view: { width: 900, height: 600 },
  player: {
    radius: 14,
    speed: 220,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    maxHealth: 100,
    inventorySlots: 6,
    nameMax: 8,
  },
  stamina: {
    max: STAMINA_MAX,
    // A full bar lasts 3s.
    drain: STAMINA_MAX / 3,
    // Empty to full in 4s.
    regen: STAMINA_MAX / 4,
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3,
  },
  vision: { coneAngle: Math.PI / 2, rays: 360, surroundingsRadius: CELL * 1.4 },
  light: { range: CELL * 6 },
  net: { smoothing: 12, useSlack: { distance: 80, seconds: 0.3 } },

  room: {
    sendHz: 15,
    entityHz: 10,
    heartbeatMs: 1000,
    presence: {
      awayAfterMs: 3500,
      goneSilentMs: 30_000,
      goneHiddenMs: 180_000,
    },
  },
  monsters: {
    chaserDensity: 0.6,
    minChasers: 2,
    seed: 1,
    clearance: CELL * 10,
    chaser: {
      radius: 15,
      maxHealth: 30,
      attackDamage: 35,
      wanderSpeed: 55,
      chaseSpeed: 150,
      sightRange: CELL * 5,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.8, max: 3 },
      repathDistance: CELL / 2,
    },
  },
  shovel: {
    radius: 20,
    reach: 45,
    damage: 20,
    knockback: 30,
    cooldown: 1,
    duration: 0.18,
    volume: 0.8,
  },
  sim: { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 },
  voice: { full: 100, silent: 600, pan: 300 },
  voiceConnections: {
    levelRampS: 0.05,
    connectDeadlineMs: 15_000,
    pending: { cap: 32, ttlMs: 5000 },
    retry: { firstMs: 2000, maxMs: 60_000 },
  },
  audio: { full: 0, silent: 1000, pan: 500 },
  ui: { debugRefreshMs: 250 },
} as const satisfies AppConfig;
