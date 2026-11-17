import { defineScrap } from "../scrap/index.js";
// Plain scrap's sounds until dark scrap's own arrive; swap these imports for the ones below.
import cashoutUrl from "../scrap/sfx/cashout.mp3";
import dropUrl from "../scrap/sfx/drop.mp3";
// import cashoutUrl from "./sfx/cashout.mp3";
// import dropUrl from "./sfx/drop.mp3";

/** The cold violet its glyph glows and glints in, there in the deepdark. */
const VIOLET = "#9b6bff";

/**
 * Dark scrap: scrap worth more than plain, lying about the world from the start but there to
 * nobody, seen and picked up only while it lies in deepdark, where it glows a cold violet.
 * Carried, it sells, drops and clatters as any scrap does.
 */
export const darkScrap = defineScrap("darkScrap", {
  name: "Dark scrap",
  emoji: "🔩",
  glint: VIOLET,
  onlyInDeepdark: true,
  cashoutUrl,
  dropUrl,
});
