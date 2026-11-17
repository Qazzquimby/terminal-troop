import { placeBomb } from "../../entities/index.js";
import { definePlaceable } from "../placeable.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const placeUrl = new URL("./sfx/light.mp3", import.meta.url).href;

/**
 * A bomb: the use control sets it down, its fuse lit with a hiss, in the middle of the cell its
 * holder stands in, so its burst runs along the grid. Its one use is spent setting it down.
 */
export const bomb = definePlaceable("bomb", {
  name: "Bomb",
  emoji: "💣",
  placeUrl,
  place: (game, user) => placeBomb(game, user),
});
