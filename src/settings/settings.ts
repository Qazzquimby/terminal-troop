import { z } from "zod";

const VOICE_MODES = ["open", "pushToTalk"] as const;

type VoiceMode = (typeof VOICE_MODES)[number];

export interface Settings {
  readonly voice: {
    readonly mode: VoiceMode;
    readonly muted: boolean;
    readonly volume: number;
    /** The microphone to capture, by device id; null for the browser default. */
    readonly inputDevice: string | null;
  };
  readonly audio: {
    readonly masterVolume: number;
  };
}

export interface SettingsPatch {
  readonly voice?: Partial<Settings["voice"]>;
  readonly audio?: Partial<Settings["audio"]>;
}

/** Where settings are kept between visits. Either method may throw; the store copes. */
export interface SettingsStorage {
  get: () => string | null;
  set: (value: string) => void;
}

type Listener = (settings: Settings) => void;

export const DEFAULT_SETTINGS: Settings = {
  voice: {
    mode: "pushToTalk",
    muted: false,
    volume: 1,
    inputDevice: null,
  },
  audio: { masterVolume: 1 },
};

/** Out-of-range volumes are clamped to 0..1; NaN and non-numbers are invalid. */
const unit = z.number().transform((value) => Math.min(1, Math.max(0, value)));

/**
 * Parses field by field: any invalid field, or missing group, takes its value from `fallback`.
 * Loading falls back to the defaults; updating falls back to the current settings.
 */
function schemaFallingBackTo(fallback: Settings) {
  return z
    .object({
      voice: z
        .object({
          mode: z.enum(VOICE_MODES).catch(fallback.voice.mode),
          muted: z.boolean().catch(fallback.voice.muted),
          volume: unit.catch(fallback.voice.volume),
          inputDevice: z.string().nullable().catch(fallback.voice.inputDevice),
        })
        .catch(fallback.voice),
      audio: z
        .object({ masterVolume: unit.catch(fallback.audio.masterVolume) })
        .catch(fallback.audio),
    })
    .catch(fallback);
}

function load(storage: SettingsStorage): Settings {
  try {
    const raw = storage.get();
    if (raw === null) return DEFAULT_SETTINGS;
    const data: unknown = JSON.parse(raw);
    return schemaFallingBackTo(DEFAULT_SETTINGS).parse(data);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Settings that persist through `storage`. `update` clamps out-of-range volumes and ignores
 * any other invalid field, keeping its current value.
 */
export function createSettingsStore(storage: SettingsStorage) {
  let current = load(storage);
  const listeners = new Set<Listener>();

  return {
    get(): Settings {
      return current;
    },

    update(patch: SettingsPatch): void {
      const merged = {
        voice: { ...current.voice, ...patch.voice },
        audio: { ...current.audio, ...patch.audio },
      };
      const next = schemaFallingBackTo(current).parse(merged);
      const serialized = JSON.stringify(next);
      if (serialized === JSON.stringify(current)) return;

      current = next;
      try {
        storage.set(serialized);
      } catch {
        // Unavailable storage only costs persistence; the session keeps the new settings.
      }
      for (const listener of listeners) listener(current);
    },

    /** Calls `listener` after each change. Returns an unsubscribe function. */
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
