import type { SpatialFalloff } from "./audio/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { UiConfig } from "./ui/index.js";
import type { VoiceConnectionConfig, VoiceFalloff } from "./voice/index.js";

/** Every tunable, grouped by concern; each group has the shape its module declares. */
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
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
    inventorySlots: 12,
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
  light: { range: CELL * 4 },
  net: { smoothing: 12 },
  room: { sendHz: 15, staleS: 15 },
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
