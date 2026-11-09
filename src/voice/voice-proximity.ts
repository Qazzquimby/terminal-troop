import {
  VOICE_FULL_DISTANCE,
  VOICE_PAN_DISTANCE,
  VOICE_SILENT_DISTANCE,
} from "./config.js";
import { spatialMix } from "./audio.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import type { PeerMix, Voice } from "./voice.js";

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
