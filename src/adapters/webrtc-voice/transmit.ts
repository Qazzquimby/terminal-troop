import type { VoiceMode } from "../../voice/index.js";

export function isTransmitting(
  mode: VoiceMode,
  talking: boolean,
  muted: boolean,
): boolean {
  if (muted) return false;
  return mode === "open" || talking;
}
