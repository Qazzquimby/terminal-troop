import { spatialMix } from "../audio/index.js";
import type { SpatialFalloff } from "../audio/index.js";
import type { Point } from "../sim/index.js";
import type { PeerMix } from "./voice.js";

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
