import { placeStunTrap } from "../../entities/index.js";
import { definePlaceable } from "../placeable.js";
// The click of it being set down, once its asset lands; importing a missing file breaks the build.
// import placeUrl from "./sfx/place.mp3";

/**
 * A stun trap: the use control puts it down at its holder's feet, where it arms and waits for
 * something to step on it. Its one use is spent putting it down.
 */
export const stunTrap = definePlaceable("stunTrap", {
  name: "Stun Trap",
  emoji: "🪤",
  // placeUrl,
  place(game, user) {
    const at = { x: user.x, y: user.y };
    placeStunTrap(game, at);
    return at;
  },
});
