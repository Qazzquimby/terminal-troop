import { defineGun } from "../gun.js";
// Its report and its last empty click, once their assets land; importing a missing file breaks
// the build. Until then it fires and runs dry without a sound, its noise carrying all the same.
// import shotUrl from "./sfx/shot.mp3";
// import emptyUrl from "./sfx/empty.mp3";

/** The handgun: one shot at a time, straight where its holder aims. */
export const handgun = defineGun("handgun", {
  name: "Handgun",
  emoji: "🔫",
  // shotUrl,
  // breaksUrl: emptyUrl,
});
