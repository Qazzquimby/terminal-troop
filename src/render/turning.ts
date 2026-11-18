import { pulledAim } from "../sim/index.js";
import type { Player, Session } from "../sim/index.js";
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

/**
 * A turning view on foot, as a body pulling the local player's gaze holds it: `heading`, the way
 * the mouse has turned it, and `held`, where the pull last had the view while it held it, or null
 * while nothing does.
 */
export interface HeldView {
  readonly heading: number;
  readonly held: number | null;
}

/**
 * `view` a frame on, and the way it faces now. While a body pulls the local player's gaze the view
 * faces where the pull drags its aim, as the aim itself does; the mouse turning it meanwhile only
 * turns what the pull drags from. Once let go, the view stays where the pull left it, its heading
 * taking up from there, rather than swinging back to where the mouse had it.
 */
export function pulledView(
  game: Session,
  view: HeldView,
): HeldView & { readonly facing: number } {
  const facing = pulledAim(game, game.local, view.heading);
  if (Math.abs(Math.sin((facing - view.heading) / 2)) > 1e-9)
    return { heading: view.heading, held: facing, facing };
  const heading = view.held ?? view.heading;
  return { heading, held: null, facing: heading };
}
