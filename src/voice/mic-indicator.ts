import type { Voice } from "./voice.js";

type MicStatus = Pick<
  ReturnType<Voice["status"]>,
  "mode" | "mic" | "transmitting"
>;

type MicTone = "open" | "talking" | "idle" | "muted" | "off";

export interface MicIndicator {
  readonly label: string;
  readonly tone: MicTone;
}

/**
 * What the player's own mic is doing, as a short label and a colour tone.
 * `talkKey` is the display text of the push-to-talk key.
 */
export function micIndicator(
  status: MicStatus,
  muted: boolean,
  talkKey: string,
): MicIndicator {
  if (status.mic === "pending") return { label: "Mic…", tone: "off" };
  if (status.mic !== "live") return { label: "No mic", tone: "off" };
  if (muted) return { label: "Muted", tone: "muted" };
  if (status.mode === "open") return { label: "Open mic", tone: "open" };
  return {
    label: `Push to talk (${talkKey})`,
    tone: status.transmitting ? "talking" : "idle",
  };
}
