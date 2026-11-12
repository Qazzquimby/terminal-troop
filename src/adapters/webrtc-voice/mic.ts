import type { MicDevice, MicPermission, MicState } from "../../voice/index.js";

/** Capture settings for the mic, on `deviceId` alone, or the default when null. */
export function micConstraints(
  deviceId: string | null,
): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId === null ? {} : { deviceId: { exact: deviceId } }),
    },
  };
}

/**
 * What the player can do about the mic, from whether the page can reach one at all
 * (`supported`), what the permissions API reports (null where it says nothing), and how the
 * last capture went. A refusal outranks the permissions API, which may lag behind it.
 */
export function micPermission(
  supported: boolean,
  reported: PermissionState | null,
  state: MicState,
): MicPermission {
  if (!supported) return "unavailable";
  if (state === "denied") return "denied";
  if (state === "live") return "granted";
  return reported ?? "prompt";
}

/** The audio inputs among `devices`, without the browser's "default" and "communications" aliases. */
export function audioInputs(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
): MicDevice[] {
  return devices
    .filter(
      ({ kind, deviceId }) =>
        kind === "audioinput" &&
        deviceId !== "" &&
        deviceId !== "default" &&
        deviceId !== "communications",
    )
    .map(({ deviceId, label }) => ({ id: deviceId, label }));
}

/** Quietest level the meter shows above zero, in dBFS. */
const FLOOR_DB = -60;

/** Loudness of `samples` (-1..1) for a meter: 0 at -60 dBFS or below, 1 at full scale. */
export function micLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}
