import type {
  MicDevice,
  MicState,
  VoiceDiagnostics,
} from "../../voice/index.js";
import { createScope } from "../../lib/scope/index.js";
import type { Scope } from "../../lib/scope/index.js";
import { disposeQuietly } from "./scopes.js";
import { audioInputs, micConstraints, micLevel, micPermission } from "./mic.js";

/** What getUserMedia fails with when the device asked for is not there. */
const MISSING_DEVICE = new Set(["OverconstrainedError", "NotFoundError"]);

function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException
    ? error.name
    : "";
}

/**
 * The player's microphone: one captured track at a time, on the chosen device, with a level
 * meter on it. `onTrack` hears each time the track is replaced or lost.
 */
export function createMicCapture(
  audioContext: () => AudioContext,
  initialDevice: string | null,
  onTrack: () => void,
) {
  // Absent outside secure contexts (plain http on a LAN address).
  const supported = "mediaDevices" in navigator;
  let state: MicState = supported ? "pending" : "unavailable";
  let track: MediaStreamTrack | null = null;
  /** Owns the current track and its meter. */
  let trackScope: Scope | null = null;
  let capturing = false;
  let wanted = initialDevice;
  let reported: PermissionState | null = null;
  let devices: MicDevice[] = [];
  let meter: AnalyserNode | null = null;
  let samples: Float32Array<ArrayBuffer> | null = null;

  async function refreshDevices(): Promise<void> {
    try {
      devices = audioInputs(await navigator.mediaDevices.enumerateDevices());
    } catch {
      devices = [];
    }
  }

  function use(next: MediaStreamTrack): void {
    const previous = trackScope;
    const scope = createScope();
    trackScope = scope;
    track = next;
    state = "live";
    scope.adopt(next, (stopping) => {
      stopping.stop();
    });
    const context = audioContext();
    const source = context.createMediaStreamSource(new MediaStream([next]));
    const analyser = context.createAnalyser();
    source.connect(analyser);
    meter = analyser;
    samples = null;
    scope.defer(() => {
      source.disconnect();
      if (meter === analyser) meter = null;
    });
    // An unplugged device ends its track; the player can pick another or ask again.
    next.addEventListener(
      "ended",
      () => {
        if (track !== next) return;
        track = null;
        state = "unavailable";
        disposeQuietly(scope);
        onTrack();
      },
      { signal: scope.signal },
    );
    onTrack();
    if (previous !== null) disposeQuietly(previous);
  }

  function capture(): void {
    if (!supported || capturing) return;
    capturing = true;
    void audioContext().resume();
    attempt(wanted, wanted);
  }

  /** Captures `deviceId` for the choice `chosen`, falling back to the default when it is gone. */
  function attempt(chosen: string | null, deviceId: string | null): void {
    navigator.mediaDevices.getUserMedia(micConstraints(deviceId)).then(
      (stream) => {
        capturing = false;
        const [next] = stream.getAudioTracks();
        if (next !== undefined) use(next);
        else if (track === null) state = "unavailable";
        void refreshDevices();
        if (wanted !== chosen && track !== null) capture();
      },
      (error: unknown) => {
        const name = errorName(error);
        if (deviceId !== null && MISSING_DEVICE.has(name)) {
          attempt(chosen, null);
          return;
        }
        capturing = false;
        // A failed switch keeps the device already captured.
        if (track !== null) return;
        state = name === "NotAllowedError" ? "denied" : "unavailable";
      },
    );
  }

  /** Follows the browser's permission for the mic, capturing as soon as it is granted again. */
  function watchPermission(): void {
    if (!("permissions" in navigator)) return;
    navigator.permissions.query({ name: "microphone" }).then(
      (status) => {
        reported = status.state;
        status.addEventListener("change", () => {
          reported = status.state;
          void refreshDevices();
          if (
            status.state === "granted" &&
            track === null &&
            state !== "pending"
          )
            capture();
        });
      },
      () => undefined,
    );
  }

  if (supported) {
    void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", () => {
      void refreshDevices();
    });
    watchPermission();
  }

  function level(): number {
    if (meter === null || track?.enabled !== true) return 0;
    samples ??= new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(samples);
    return micLevel(samples);
  }

  return {
    /** Captures the mic unless it is captured or being asked for already. */
    request(): void {
      void audioContext().resume();
      if (track === null) capture();
    },
    /** Captures `deviceId` (null: the default) in place of the current track, if there is one. */
    setDevice(deviceId: string | null): void {
      if (deviceId === wanted) return;
      wanted = deviceId;
      if (track !== null) capture();
    },
    track: (): MediaStreamTrack | null => track,
    /** Loudness of the captured track, 0..1, while it is enabled; 0 otherwise. */
    level,
    state: (): MicState => state,
    report(): Omit<VoiceDiagnostics["mic"], "testing"> {
      return {
        permission: micPermission(supported, reported, state),
        state,
        devices,
        device: track?.getSettings().deviceId ?? null,
        level: level(),
      };
    },
  };
}
