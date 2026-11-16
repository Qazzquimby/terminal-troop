import { placeTurret } from "../../entities/index.js";
import { definePlaceable } from "../placeable.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const placeUrl = new URL("./sfx/place.mp3", import.meta.url).href;

/**
 * A turret: the use control sets it down just ahead of its holder, facing the way it aims, where
 * it sets up and starts sweeping for something to shoot. Its one use is spent setting it down.
 */
export const turret = definePlaceable("turret", {
  name: "Turret",
  emoji: "🗼",
  placeUrl,
  place: placeTurret,
});
