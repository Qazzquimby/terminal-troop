import { voiceRoutes } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { routedMix } from "../voice/index.js";
import type { PeerMix, VoiceFalloff, VoiceRoom } from "../voice/index.js";

/**
 * The mix for remote player `id` by every way its voice reaches the local player: through the air
 * from where it stands, and through whatever else carries it, such as walkie talkies. Null
 * without such a player.
 */
function mixFor(
  session: Session,
  id: string,
  falloff: VoiceFalloff,
): PeerMix | null {
  const player = session.players.get(id);
  if (player === undefined || id === session.localId) return null;
  const routes = voiceRoutes(session, player, session.local);
  return routedMix(session.local, routes, falloff);
}

/** Mixes the voice of each of `ids` by every way it reaches the local player. */
export function applyProximity(
  session: Session,
  ids: Iterable<string>,
  room: Pick<VoiceRoom, "setPeerMix">,
  falloff: VoiceFalloff,
): void {
  for (const id of ids) {
    const mix = mixFor(session, id, falloff);
    if (mix !== null) room.setPeerMix(id, mix);
  }
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Points `room` at those of `ids` that are remote players of `session`, given the set it was
 * last pointed at, and returns the set it now holds. A player new to the set gets its
 * proximity mix before the room hears of it, so its voice never starts at the wrong volume.
 * Does nothing when the set is unchanged.
 */
export function syncVoicePeers(
  session: Session,
  ids: Iterable<string>,
  room: Pick<VoiceRoom, "setPeerMix" | "setPeers">,
  current: ReadonlySet<string>,
  falloff: VoiceFalloff,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (id !== session.localId && session.players.has(id)) next.add(id);
  }
  if (sameIds(next, current)) return current;
  applyProximity(
    session,
    [...next].filter((id) => !current.has(id)),
    room,
    falloff,
  );
  room.setPeers(next);
  return next;
}
