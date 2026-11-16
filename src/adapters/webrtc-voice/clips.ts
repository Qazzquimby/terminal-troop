import type { VoiceClip, VoiceClipConfig } from "../../voice/index.js";

/*
 * Clips of the player's own speech, cut between pauses, for monsters that speak in its voice.
 * A clip is only ever what the mic sent out live to at least one connected player: recording
 * starts once speech going out crosses a level, and a clip is cut as soon as the mic stops going
 * out (muted, push-to-talk let go) or after a pause. Nothing is recorded while the player is
 * muted, has no mic, is testing it, or talks to no one, and the clips are forgotten on leaving the
 * room.
 */

/** Where the cutter stands: waiting for speech, or recording since `since`, last loud at `loudAt`. */
export type Cut =
  | { readonly kind: "idle" }
  | {
      readonly kind: "recording";
      readonly since: number;
      readonly loudAt: number;
    };

/**
 * What to do with the recorder this poll: start one, stop it and keep the clip, stop it and
 * throw the clip away, or nothing.
 */
export type CutAct = "start" | "keep" | "discard" | null;

export const IDLE: Cut = { kind: "idle" };

/** Whether a clip from `since`, last loud at `loudAt`, holds enough speech to keep. */
const enough = (
  since: number,
  loudAt: number,
  config: VoiceClipConfig,
): boolean => loudAt - since >= config.minSeconds;

/**
 * The next cut from `cut`, the mic going out at `level` (0..1) at `now`, in seconds, `live` while
 * it goes out to someone at all, and what to do with the recorder.
 * - idle: live speech at the threshold or louder starts a clip
 * - recording: a clip ends, kept if it held enough speech, once the mic stops going out or speech
 *   has paused for the quiet spell; it ends and is kept once it reaches the longest a clip runs
 */
export function nextCut(
  cut: Cut,
  level: number,
  live: boolean,
  now: number,
  config: VoiceClipConfig,
): { readonly cut: Cut; readonly act: CutAct } {
  const loud = live && level >= config.threshold;
  if (cut.kind === "idle")
    return loud
      ? { cut: { kind: "recording", since: now, loudAt: now }, act: "start" }
      : { cut, act: null };
  const loudAt = loud ? now : cut.loudAt;
  if (now - cut.since >= config.maxSeconds) return { cut: IDLE, act: "keep" };
  if (!live || now - loudAt >= config.quietSeconds)
    return {
      cut: IDLE,
      act: enough(cut.since, loudAt, config) ? "keep" : "discard",
    };
  return { cut: { ...cut, loudAt }, act: null };
}

/** Of the media types a recorder may make, the first this browser records; null for none. */
const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

function recordable(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** `bytes` in base64. */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + CHUNK)));
  return btoa(parts.join(""));
}

/** What the recorder reads of the mic. */
interface ClipSource {
  /** The captured track, or null without one. */
  track(): MediaStreamTrack | null;
  /** How loud the mic goes out now, 0..1. */
  level(): number;
  /** Whether the mic goes out to at least one connected player now. */
  live(): boolean;
}

/** The clips held, newest last, and a way to stop recording and forget them. */
export interface ClipRecorder {
  count(): number;
  clip(index: number): VoiceClip | null;
  stop(): void;
}

/**
 * Polls the mic every `pollMs`, recording clips as `nextCut` has them and holding the newest
 * `keep`. Records nothing in a browser without MediaRecorder.
 */
export function createClipRecorder(
  source: ClipSource,
  config: VoiceClipConfig,
): ClipRecorder {
  const mimeType = recordable();
  const clips: VoiceClip[] = [];
  let cut: Cut = IDLE;
  /** Stops the recording under way, keeping its clip or not; null while none is. */
  let finish: ((keep: boolean) => void) | null = null;
  let stopped = false;

  function hold(clip: VoiceClip): void {
    if (stopped) return;
    clips.push(clip);
    while (clips.length > config.keep) clips.shift();
  }

  function start(): void {
    const track = source.track();
    if (mimeType === null || track === null) return;
    const chunks: Blob[] = [];
    let keeping = false;
    const recorder = new MediaRecorder(new MediaStream([track]), {
      mimeType,
      audioBitsPerSecond: config.bitsPerSecond,
    });
    recorder.addEventListener("dataavailable", (event) => {
      chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      if (!keeping) return;
      const type = recorder.mimeType === "" ? mimeType : recorder.mimeType;
      void new Blob(chunks, { type }).arrayBuffer().then((buffer) => {
        hold({ mime: type, data: toBase64(new Uint8Array(buffer)) });
      });
    });
    recorder.start();
    finish = (keep) => {
      keeping = keep;
      if (recorder.state !== "inactive") recorder.stop();
      finish = null;
    };
  }

  const timer = setInterval(() => {
    const next = nextCut(
      cut,
      source.level(),
      source.live(),
      performance.now() / 1000,
      config,
    );
    cut = next.cut;
    if (next.act === "start") start();
    else if (next.act !== null) finish?.(next.act === "keep");
  }, config.pollMs);

  return {
    count: () => clips.length,
    clip: (index) =>
      clips.length === 0 ? null : (clips[index % clips.length] ?? null),
    stop() {
      stopped = true;
      clearInterval(timer);
      finish?.(false);
      clips.length = 0;
    },
  };
}
