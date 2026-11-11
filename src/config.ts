import type { SpatialFalloff } from "./audio/index.js";
import type { EntitiesConfig } from "./entities/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
} from "./render/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { ItemsConfig } from "./items/index.js";
import type { MovesConfig } from "./moves/index.js";
import type { UiConfig } from "./ui/index.js";
import type { VoiceConnectionConfig, VoiceFalloff } from "./voice/index.js";

/** Every tunable, grouped by concern; each group has the shape its module declares. */
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
  readonly camera: CameraConfig;
  readonly ripples: RippleConfig;
  readonly flashes: FlashConfig;
  readonly mapMemory: MapMemoryConfig;
  readonly entities: EntitiesConfig;
  readonly items: ItemsConfig;
  readonly moves: MovesConfig;
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
  // Eases out from 1:1 by a fifth of the gap each 60Hz frame.
  camera: { zoom: 1.25, zoomRate: 13.4 },
  // What the local player hears, drawn as ripples: a walking step 3.5 cells off and a sprinting
  // one 11 cells off.
  ripples: {
    hearingRange: CELL * 7,
    duration: 0.9,
    radius: { min: 12, perLoudness: 40 },
    width: { sharp: 1.5, soft: 7 },
    alpha: { sharp: 0.85, soft: 0.2 },
    colour: "#9fd3ff",
  },
  // Terrain seen before and out of sight now: grey, the floor barely there, walls easier to read.
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50,
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
  },
  // A kick's flash: three quarters of its size at first, swelling to full as it fades over 0.3s.
  flashes: {
    duration: 0.3,
    start: 0.75,
    fill: 0.55,
    width: 4,
    colour: { hit: "#ffb04a", miss: "#e6edf3" },
  },
  player: {
    radius: 14,
    speed: 120,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    crouchMultiplier: 0.5,
    maxHealth: 100,
    inventorySlots: 9,
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
  // A noise 10 cells off seems to come from anywhere within 2.5 cells of it.
  noise: { blur: 0.25 },
  // Loudness is a multiple of a listener's hearing range.
  footsteps: {
    walk: { interval: 0.5, loudness: 0.5 },
    sprint: { interval: 0.3, loudness: 1.6 },
    crouch: { interval: 0.7, loudness: 0.15 },
  },
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
  entities: {
    chaser: {
      spawn: {
        count: { density: 1.2, min: 2 },
        seed: 1,
        clearance: CELL * 10,
      },
      radius: 15,
      maxHealth: 40,
      attackDamage: 35,
      wanderSpeed: 60,
      chaseSpeed: 120,
      sightRange: CELL * 5,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.4, max: 1.5 },
      repathDistance: CELL / 2,
      barkGap: { min: 6, max: 12 },
      attackRange: 30,
      attackCooldown: 2,
      hearingRange: CELL * 5,
    },
    cruiser: {
      lightRadius: CELL * 12,
      offset: CELL,
    },
  },
  items: {
    shovel: {
      radius: 20,
      reach: 45,
      damage: 15,
      knockback: 20,
      cooldown: 1,
      duration: 0.18,
      volume: 0.8,
      hitLoudness: 1.2,
    },
  },
  moves: {
    // A lunge of one body length into a kick that lands a little short of the shovel; five
    // kicks fell a chaser, each sending it 2.5 of its own body lengths away.
    kick: {
      reach: 32,
      radius: 18,
      damage: 8,
      knockback: 2.5,
      cooldown: 0.8,
      stamina: STAMINA_MAX * 0.15,
      lunge: { lengths: 1, seconds: 0.08 },
      loudness: 1,
    },
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
