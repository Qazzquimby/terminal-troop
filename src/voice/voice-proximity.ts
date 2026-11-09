import { spatialMix } from "../audio/audio.js";
import type { Point, Session } from "../sim/index.js";
import type { PeerMix, Voice } from "./voice.js";

/** Voices are at full volume within this distance, in pixels. */
export const VOICE_FULL_DISTANCE = 100;
/** Voices are silent beyond this distance, in pixels. */
export const VOICE_SILENT_DISTANCE = 600;
/** Horizontal offset at which a voice is panned fully to one side, in pixels. */
export const VOICE_PAN_DISTANCE = 300;

const VOICE_FALLOFF = {
  full: VOICE_FULL_DISTANCE,
  silent: VOICE_SILENT_DISTANCE,
  pan: VOICE_PAN_DISTANCE,
} as const;

/** How loud `speaker` sounds to `listener`, and from which side. */
export function voiceMix(listener: Point, speaker: Point): PeerMix {
  return spatialMix(speaker, listener, VOICE_FALLOFF);
}

/** Mixes every remote player's voice by their position relative to the local player. */
export function applyProximity(session: Session, voice: Voice): void {
  session.players.forEach((player, id) => {
    if (id !== session.localId)
      voice.setPeerMix(id, voiceMix(session.local, player));
  });
}
