import { expect, test, vi } from "vitest";
import type { Settings, SettingsStorage } from "./settings.js";
import { DEFAULT_SETTINGS, createSettingsStore } from "./settings.js";

function memoryStorage(initial: string | null = null) {
  const storage = {
    value: initial,
    get: () => storage.value,
    set: (value: string) => {
      storage.value = value;
    },
  };
  return storage;
}

const throwingStorage: SettingsStorage = {
  get: () => {
    throw new Error("storage unavailable");
  },
  set: () => {
    throw new Error("storage unavailable");
  },
};

test("a fresh store has the defaults", () => {
  const store = createSettingsStore(memoryStorage());
  expect(store.get()).toEqual({
    voice: { mode: "pushToTalk", muted: false, volume: 1, inputDevice: null },
    audio: { masterVolume: 1 },
  });
});

test("update merges into the current settings and persists them", () => {
  const storage = memoryStorage();
  const store = createSettingsStore(storage);

  store.update({ voice: { muted: true } });
  store.update({ audio: { masterVolume: 0.25 } });

  const expected = {
    voice: { mode: "pushToTalk", muted: true, volume: 1, inputDevice: null },
    audio: { masterVolume: 0.25 },
  };
  expect(store.get()).toEqual(expected);
  expect(createSettingsStore(storage).get()).toEqual(expected);
});

test("update clamps out-of-range volumes", () => {
  const store = createSettingsStore(memoryStorage());
  store.update({ voice: { volume: 3 }, audio: { masterVolume: -1 } });
  expect(store.get().voice.volume).toBe(1);
  expect(store.get().audio.masterVolume).toBe(0);
});

test("update ignores invalid values and keeps the current ones", () => {
  const store = createSettingsStore(memoryStorage());
  store.update({ voice: { mode: "open", volume: 0.5 } });

  // Values outside the type, as an untyped caller could pass.
  const invalid: Partial<Settings["voice"]> = {};
  Reflect.set(invalid, "mode", "shout");
  Reflect.set(invalid, "volume", "loud");
  store.update({ voice: invalid });
  store.update({ voice: { volume: Number.NaN } });

  expect(store.get().voice).toEqual({
    mode: "open",
    muted: false,
    volume: 0.5,
    inputDevice: null,
  });
});

test("corrupt stored JSON gives the defaults", () => {
  const store = createSettingsStore(memoryStorage("{not json"));
  expect(store.get()).toEqual(DEFAULT_SETTINGS);
});

test("partially valid stored data keeps its valid fields", () => {
  const stored = JSON.stringify({
    voice: { mode: "pushToTalk", muted: "yes", volume: 0.4 },
    audio: 7,
  });
  const store = createSettingsStore(memoryStorage(stored));
  expect(store.get()).toEqual({
    voice: { mode: "pushToTalk", muted: false, volume: 0.4, inputDevice: null },
    audio: { masterVolume: 1 },
  });
});

test("subscribers hear changes until they unsubscribe", () => {
  const store = createSettingsStore(memoryStorage());
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);

  store.update({ voice: { mode: "open" } });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenLastCalledWith(store.get());

  store.update({ voice: { mode: "open" } });
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
  store.update({ voice: { muted: true } });
  expect(listener).toHaveBeenCalledTimes(1);
});

test("throwing storage falls back to defaults and still applies updates", () => {
  const store = createSettingsStore(throwingStorage);
  expect(store.get()).toEqual(DEFAULT_SETTINGS);

  const listener = vi.fn();
  store.subscribe(listener);
  store.update({ audio: { masterVolume: 0.5 } });

  expect(store.get().audio.masterVolume).toBe(0.5);
  expect(listener).toHaveBeenCalledTimes(1);
});

test("the chosen microphone persists until it is set back to the default", () => {
  const storage = memoryStorage();
  const store = createSettingsStore(storage);
  store.update({ voice: { inputDevice: "usb-mic" } });
  expect(createSettingsStore(storage).get().voice.inputDevice).toBe("usb-mic");

  store.update({ voice: { inputDevice: null } });
  expect(createSettingsStore(storage).get().voice.inputDevice).toBeNull();
});

test("a stored device that is not a string loads as the default", () => {
  const stored = JSON.stringify({ voice: { inputDevice: 7 } });
  expect(
    createSettingsStore(memoryStorage(stored)).get().voice.inputDevice,
  ).toBeNull();
});
