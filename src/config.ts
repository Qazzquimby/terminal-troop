import type { SpatialFalloff } from "./audio/index.js";
import type { EntitiesConfig } from "./entities/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
} from "./render/index.js";
import type { PositionMemoryConfig } from "./position-memory/index.js";
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
  readonly positionMemory: PositionMemoryConfig;
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
  world: { cell: CELL, cols: 100, rows: 80, seed: 1, wallBounce: 0 },
  view: { width: 900, height: 600 },
  // Eases out from 1:1 by a fifth of the gap each 60Hz frame. Follows the player by a quarter of
  // the gap each 60Hz frame: about 7px behind at a walk and 12px at a sprint, so a lunge leads
  // it. A jump of more than 4 cells, such as a respawn, is cut to rather than panned across.
  camera: {
    zoom: 1.25,
    zoomRate: 13.4,
    followRate: 18,
    snapDistance: CELL * 4,
  },
  // Noises the local player hears, each drawn as a ring growing out to the noise's radius.
  ripples: {
    duration: 0.9,
    width: { sharp: 1.5, soft: 7 },
    alpha: { sharp: 0.65, soft: 0.15 },
    colour: "#9fd3ff",
  },
  // Terrain seen before and out of sight now: grey, the floor barely there, walls easier to read.
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50,
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
  },
  // Where the player stands, saved every 2s while it moves, so a reload puts it back there.
  positionMemory: { saveInterval: 2, maxRooms: 50 },
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
    inventorySlots: 6,
    nameMax: 8,
    knockbackSeconds: 0.15,
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
  // A player new to a world starts within 2 cells of its rally point, where the cruiser waits.
  arrival: { spread: CELL * 2 },
  vision: { coneAngle: Math.PI / 2, rays: 360, surroundingsRadius: CELL * 1.4 },
  light: { range: CELL * 6 },
  // A guest holds a hit it predicted for up to a second before the host confirms it.
  net: {
    smoothing: 12,
    useSlack: { distance: 80, seconds: 0.3 },
    predictionHold: 1,
  },
  // A noise 10 cells off seems to come from anywhere within 2.5 cells of it.
  noise: { blur: 0.25 },
  // Each step is heard by anything within its radius: a sprint carries well past a chaser's
  // sight, a walk a few cells, a crouch barely past arm's length.
  footsteps: {
    walk: { interval: 0.5, radius: CELL * 5 },
    sprint: { interval: 0.3, radius: CELL * 16 },
    crouch: { interval: 0.7, radius: CELL * 1.5 },
  },
  // Items lying about: a 16px glyph, picked up at most five times a second.
  worldItems: { radius: 8, cooldown: 0.2 },
  room: {
    sendHz: 10,
    fullSnapshotMs: 5000,
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
      // One more every 12 seconds as a world begins, the gap falling evenly to one a second over its
      // first five minutes; never within 14 cells of a player, nor past 120 alive.
      spawning: {
        firstGap: 12,
        lastGap: 1,
        rampSeconds: 300,
        maxAlive: 120,
        tries: 24,
        unseenDistance: 700,
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
    },
    cruiser: {
      lightRadius: CELL * 12,
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
      hitNoiseRadius: CELL * 14,
    },
    scrap: {
      value: 1,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      sellTimeout: 2,
      volume: 0.8,
      scatter: { count: 75, seed: 2, clearance: CELL * 3 },
    },
  },
  moves: {
    // A lunge of one body length into a kick that lands a little short of the shovel; five
    // kicks fell a chaser, each sending it 2.5 of its own body lengths away. The host takes a
    // kicker's word for where its lunge ended to within 24px: a tenth of a second of sprinting,
    // one STATE at 10Hz.
    kick: {
      reach: 32,
      radius: 18,
      damage: 8,
      knockback: 2.5,
      cooldown: 0.8,
      stamina: STAMINA_MAX * 0.15,
      lunge: { lengths: 1, seconds: 0.08, slack: 24 },
      noiseRadius: CELL * 12,
    },
  },
  sim: { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 },
  voice: { full: 100, silent: 600, pan: 300 },
  voiceConnections: {
    levelRampS: 0.05,
    connectDeadlineMs: 15_000,
    pending: { cap: 32, ttlMs: 5000 },
    retry: { firstMs: 2000, maxMs: 60_000 },
    statsIntervalMs: 1000,
  },
  audio: { full: 0, silent: 1000, pan: 500 },
  ui: { debugRefreshMs: 250 },
} as const satisfies AppConfig;
