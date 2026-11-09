import { remotePlayers } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { voiceMix } from "../voice/index.js";
import type { VoiceFalloff, VoiceRoom } from "../voice/index.js";

/** Mixes every remote player's voice by their position relative to the local player. */
export function applyProximity(
  session: Session,
  room: Pick<VoiceRoom, "setPeerMix">,
  falloff: VoiceFalloff,
): void {
  for (const player of remotePlayers(session)) {
    room.setPeerMix(player.id, voiceMix(session.local, player, falloff));
  }
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
