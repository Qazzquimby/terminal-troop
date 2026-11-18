import type { Player } from "../sim/index.js";
import type { Eye } from "./spectate.js";

/** What a body faces, as a camera turning with it follows: the vehicle it rides, or its own facing. */
function facingOf(body: Player): number {
  return body.ride?.heading ?? body.aim;
}

/**
 * The way the local client's view faces (radians) for a camera that turns with it, from
 * `heading`, the way it faced, turned by `turn` radians of mouse. What the view follows decides
 * it where it can: a vehicle the local player rides points the view along its heading, and a ghost
 * watching a player looks the way that player does. Otherwise, on foot or through a ghost's free
 * camera, the mouse turns it. Kept in step with what it follows, so turning the mouse again, or
 * getting out, carries on from there.
 */
export function viewHeading(
  heading: number,
  eye: Eye,
  local: Player,
  turn: number,
): number {
  switch (eye.kind) {
    case "watch":
      return facingOf(eye.player);
    case "self":
      return local.ride === null ? heading + turn : facingOf(local);
    case "free":
      return heading + turn;
  }
}
