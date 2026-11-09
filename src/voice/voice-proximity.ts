import { spatialMix } from "../audio/index.js";
import type { SpatialFalloff } from "../audio/index.js";
import type { Point, Session } from "../sim/index.js";
import type { PeerMix, Voice } from "./voice.js";

/** Distances, in pixels, over which a voice fades out and pans to one side. */
export type VoiceFalloff = SpatialFalloff;

/** How loud `speaker` sounds to `listener`, and from which side. */
export function voiceMix(
  listener: Point,
  speaker: Point,
  falloff: VoiceFalloff,
): PeerMix {
  return spatialMix(speaker, listener, falloff);
}

/** Mixes every remote player's voice by their position relative to the local player. */
export function applyProximity(
  session: Session,
  voice: Voice,
  falloff: VoiceFalloff,
): void {
  session.players.forEach((player, id) => {
    if (id !== session.localId)
      voice.setPeerMix(id, voiceMix(session.local, player, falloff));
  });
}
