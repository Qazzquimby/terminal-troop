import { defineGun } from "../gun.js";
// Its blast and its last empty click, once their assets land; importing a missing file breaks
// the build. Until then it fires and runs dry without a sound, its noise carrying all the same.
// import shotUrl from "./sfx/shot.mp3";
// import emptyUrl from "./sfx/empty.mp3";

/** The shotgun: a spray of handgun-like shots fanned out across an arc where its holder aims. */
export const shotgun = defineGun("shotgun", {
  name: "Shotgun",
  emoji: "💥",
  // shotUrl,
  // breaksUrl: emptyUrl,
});
