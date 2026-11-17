import { isGhost } from "./ghosts.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import type { VoiceChannel, VoiceVia } from "./voice-routes.js";

/**
 * A place in the world where the living and the ghosts hear each other: a shrine, or a ghost
 * walkie switched on. Every ghost's voice plays from `at`, as `via` has it, to every living
 * listener, fading with distance as any voice does; and a living speaker within `reach` of it is
 * heard by every ghost, wherever it is, as if beside it.
 */
export interface GhostEar {
  readonly at: Point;
  readonly via: VoiceVia;
  readonly reach: number;
}

/**
 * A voice channel through every ghost ear `ears` finds in a session, which content adds as its
 * own voice: an item or a kind that hears ghosts, each with its own rule for where it hears them.
 * Works with the ghosts' own channel, which hides a ghost where it stands from the living, so a
 * ghost reaches a living listener only through an ear.
 */
export function ghostEarChannel(
  ears: (game: Session) => readonly GhostEar[],
): VoiceChannel {
  return {
    routes(game, speaker, listener) {
      const speakerGhost = isGhost(speaker);
      if (speakerGhost === isGhost(listener)) return [];
      const found = ears(game);
      if (speakerGhost) return found.map(({ at, via }) => ({ at, via }));
      const near = found.find(
        (ear) =>
          Math.hypot(speaker.x - ear.at.x, speaker.y - ear.at.y) <= ear.reach,
      );
      return near === undefined ? [] : [{ at: null, via: near.via }];
    },
  };
}
