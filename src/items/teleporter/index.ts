import { placeTeleporter } from "../../entities/index.js";
import { definePlaceable } from "../placeable.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const placeUrl = new URL("./sfx/place.mp3", import.meta.url).href;

/**
 * A teleporter: the use control lays its pad just ahead of its holder, aimed the way it aims,
 * where it charges and then sends whatever steps on it off that way. Its one use is spent laying
 * it.
 */
export const teleporter = definePlaceable("teleporter", {
  name: "Teleporter",
  emoji: "🌀",
  placeUrl,
  place: placeTeleporter,
});
