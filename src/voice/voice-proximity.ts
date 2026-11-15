import { spatialMix } from "../audio/index.js";
import type { SpatialFalloff } from "../audio/index.js";
import type { Point, VoiceRoute } from "../sim/index.js";
import type { PeerMix } from "./voice.js";

/**
 * How much a voice carried from one place to another breaks up on the way, by how far it went:
 * `floor` up to `clear` pixels, rising smoothly to all of it at `lost` pixels and past.
 */
export interface InterferenceFalloff {
  readonly clear: number;
  readonly lost: number;
  /** The interference even side by side, 0..1: a cheap radio is never clean. */
  readonly floor: number;
}

/**
 * Distances, in pixels, over which a voice fades out and pans to one side; `radio` for a voice
 * heard through a speaker, such as a walkie talkie's, as the air's when left out. `interference`
 * is how a voice carried to that speaker breaks up with the distance it was carried; none when
 * left out.
 */
export type VoiceFalloff = SpatialFalloff & {
  readonly radio?: SpatialFalloff;
  readonly interference?: InterferenceFalloff;
};

/** How loud `speaker` sounds to `listener`, and from which side. */
export function voiceMix(
  listener: Point,
  speaker: Point,
  falloff: VoiceFalloff,
): PeerMix {
  return spatialMix(speaker, listener, falloff);
}

/** The interference, 0..1, on a voice carried `distance` pixels. */
export function interferenceAt(
  distance: number,
  falloff: InterferenceFalloff,
): number {
  const span = falloff.lost - falloff.clear;
  const t =
    span <= 0
      ? distance >= falloff.lost
        ? 1
        : 0
      : Math.min(1, Math.max(0, (distance - falloff.clear) / span));
  const smooth = t * t * (3 - 2 * t);
  return falloff.floor + (1 - falloff.floor) * smooth;
}

/** The interference on a voice carried by `route`: its floor when it went nowhere to say. */
function routeInterference(
  route: VoiceRoute,
  falloff: InterferenceFalloff | undefined,
): number {
  if (falloff === undefined) return 0;
  if (route.from === undefined || route.at === null) return falloff.floor;
  return interferenceAt(
    Math.hypot(route.at.x - route.from.x, route.at.y - route.from.y),
    falloff,
  );
}

/** The loudest of `mixes`; silent and centred for none. */
function loudest<T extends { volume: number; pan: number }>(
  mixes: readonly T[],
  none: T,
): T {
  let best = none;
  for (const mix of mixes) if (mix.volume > best.volume) best = mix;
  return best;
}

/**
 * How loud, and from which side, a voice reaching `listener` by `routes` sounds: through the air
 * as its loudest air route has it, and through a speaker as its loudest radio route has it, with
 * that route's interference. A route from no place is heard at full volume, centred. Without a
 * radio route, the mix has no radio part; without any route, it is silent.
 */
export function routedMix(
  listener: Point,
  routes: readonly VoiceRoute[],
  falloff: VoiceFalloff,
): PeerMix {
  const heard = (via: VoiceRoute["via"], fades: SpatialFalloff) =>
    routes
      .filter((route) => route.via === via)
      .map((route) => ({
        ...spatialMix(route.at, listener, fades),
        interference: routeInterference(route, falloff.interference),
      }));
  const silent = { volume: 0, pan: 0, interference: 0 };
  const { volume, pan } = loudest(heard("air", falloff), silent);
  const radio = heard("radio", falloff.radio ?? falloff);
  return radio.length === 0
    ? { volume, pan }
    : {
        volume,
        pan,
        radio: loudest(radio, {
          ...silent,
          interference: radio[0]?.interference ?? 0,
        }),
      };
}
