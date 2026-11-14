import { spatialMix } from "../audio/index.js";
import type { SpatialFalloff } from "../audio/index.js";
import type { Point, VoiceRoute } from "../sim/index.js";
import type { PeerMix } from "./voice.js";

/**
 * Distances, in pixels, over which a voice fades out and pans to one side; `radio` for a voice
 * heard through a speaker, such as a walkie talkie's, as the air's when left out.
 */
export type VoiceFalloff = SpatialFalloff & {
  readonly radio?: SpatialFalloff;
};

/** How loud `speaker` sounds to `listener`, and from which side. */
export function voiceMix(
  listener: Point,
  speaker: Point,
  falloff: VoiceFalloff,
): PeerMix {
  return spatialMix(speaker, listener, falloff);
}

/** The loudest of `mixes`; silent and centred for none. */
function loudest(mixes: readonly { volume: number; pan: number }[]) {
  let best = { volume: 0, pan: 0 };
  for (const mix of mixes) if (mix.volume > best.volume) best = mix;
  return best;
}

/**
 * How loud, and from which side, a voice reaching `listener` by `routes` sounds: through the air
 * as its loudest air route has it, and through a speaker as its loudest radio route has it. A
 * route from no place is heard at full volume, centred. Without a radio route, the mix has no
 * radio part; without any route, it is silent.
 */
export function routedMix(
  listener: Point,
  routes: readonly VoiceRoute[],
  falloff: VoiceFalloff,
): PeerMix {
  const heard = (via: VoiceRoute["via"], fades: SpatialFalloff) =>
    routes
      .filter((route) => route.via === via)
      .map((route) => spatialMix(route.at, listener, fades));
  const air = loudest(heard("air", falloff));
  const radio = heard("radio", falloff.radio ?? falloff);
  return radio.length === 0 ? air : { ...air, radio: loudest(radio) };
}
