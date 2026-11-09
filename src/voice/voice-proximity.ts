import { spatialMix } from "../audio/index.js";
import type { SpatialFalloff } from "../audio/index.js";
import type { Point, Session } from "../sim/index.js";
import type { PeerMix, VoiceRoom } from "./voice.js";

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
  room: Pick<VoiceRoom, "setPeerMix">,
  falloff: VoiceFalloff,
): void {
  session.players.forEach((player, id) => {
    if (id !== session.localId)
      room.setPeerMix(id, voiceMix(session.local, player, falloff));
  });
}

function sameRemotes(session: Session, peers: ReadonlySet<string>): boolean {
  if (session.players.size - 1 !== peers.size) return false;
  for (const id of session.players.keys()) {
    if (id !== session.localId && !peers.has(id)) return false;
  }
  return true;
}

/**
 * Points `room` at the remote players of `session`, given the set it was last pointed at, and
 * returns the set it now holds. A player new to the set gets its proximity mix before the
 * room hears of it, so its voice never starts at the wrong volume. Does nothing when the
 * players are unchanged.
 */
export function syncVoicePeers(
  session: Session,
  room: Pick<VoiceRoom, "setPeerMix" | "setPeers">,
  current: ReadonlySet<string>,
  falloff: VoiceFalloff,
): ReadonlySet<string> {
  if (sameRemotes(session, current)) return current;
  const next = new Set<string>();
  session.players.forEach((player, id) => {
    if (id === session.localId) return;
    next.add(id);
    if (!current.has(id))
      room.setPeerMix(id, voiceMix(session.local, player, falloff));
  });
  room.setPeers(next);
  return next;
}
