import { defineScrap } from "../scrap/index.js";
// Plain scrap's sounds until golden scrap's own arrive; swap these imports for the ones below.
import cashoutUrl from "../scrap/sfx/cashout.mp3";
import dropUrl from "../scrap/sfx/drop.mp3";
// import cashoutUrl from "./sfx/cashout.mp3";
// import dropUrl from "./sfx/drop.mp3";

/** Gold its glyph glows and glints in. */
const GOLD = "#ffcc33";

/**
 * Golden scrap: scrap worth more, laid rarely and deep in danger, glowing gold and glinting so a
 * player spots it from plain scrap. It sells, drops and clatters as any scrap does.
 */
export const goldenScrap = defineScrap("goldenScrap", {
  name: "Golden scrap",
  emoji: "🔩",
  glint: GOLD,
  cashoutUrl,
  dropUrl,
});
