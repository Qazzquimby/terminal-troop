import { isGhost, livingPlayers } from "../sim/index.js";
import type { Controls, Player, Point, Session } from "../sim/index.js";

/** How a ghost watches the world. */
export interface SpectateConfig {
  /** How fast the free camera moves, in pixels per second. */
  readonly speed: number;
  /**
   * How far the scroll wheel zooms its view, as a factor on the camera's own zoom: each notch
   * multiplies it by `step` (down, out) or divides it (up, in), kept within `min` and `max`.
   */
  readonly zoom: {
    readonly min: number;
    readonly max: number;
    readonly step: number;
  };
}

/**
 * What the local player's client shows of the world:
 * - self: alive, it sees what its own player sees
 * - watch: a ghost watching a living player, seeing what that player sees
 * - free: a ghost's free camera, seeing everything about `at`, through walls and darkness
 */
export type Eye =
  | { readonly kind: "self" }
  | { readonly kind: "watch"; readonly player: Player }
  | { readonly kind: "free"; readonly at: Point };

/** A ghost's view, kept on its own client: who it watches, or where its free camera is. */
export interface Spectator {
  /** The id of the living player it watches; null for none yet. */
  watching: string | null;
  /** Whether it looks through its free camera rather than watching someone. */
  free: boolean;
  /** Where it looks from: the player it watches, or its free camera; null while alive. */
  at: Point | null;
  /** Factor on the camera's zoom its view settles at: 1 as alive, larger shows more world. */
  zoom: number;
}

export function createSpectator(): Spectator {
  return { watching: null, free: false, at: null, zoom: 1 };
}

/** The living players a ghost may watch, in a fixed order to cycle through. */
const watchable = (game: Session): Player[] =>
  livingPlayers(game)
    .filter((player) => player !== game.local)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** `at` kept inside the world. */
function within(game: Session, at: Point): Point {
  return {
    x: Math.min(Math.max(at.x, 0), game.world.W),
    y: Math.min(Math.max(at.y, 0), game.world.H),
  };
}

/** `zoom` moved `notches` notches of the wheel, out for positive, kept within its bounds. */
function zoomed(
  zoom: number,
  notches: number,
  { min, max, step }: SpectateConfig["zoom"],
): number {
  return Math.min(Math.max(zoom * step ** notches, min), max);
}

/**
 * Steps the local player's view on `controls`, after the session's step. Alive, it has none.
 * A ghost watches a living player, the next or the one before on the use and secondary controls,
 * and goes on to the next once the one it watches leaves or dies; the view toggle switches to a
 * free camera, moved like a player, and back. With no one living to watch, it looks through the
 * free camera. A ghost hears from where it looks, so its body, which nothing else meets, goes
 * there. The scroll wheel, which switches items while alive, zooms a ghost's view in and out;
 * coming back to life sets the zoom back.
 */
export function stepSpectator(
  spectator: Spectator,
  game: Session,
  controls: Controls,
  dt: number,
  config: SpectateConfig,
): void {
  const { local } = game;
  if (!isGhost(local)) {
    Object.assign(spectator, createSpectator());
    return;
  }
  const from = spectator.at ?? { x: local.x, y: local.y };
  spectator.zoom = zoomed(spectator.zoom, controls.cycle, config.zoom);
  if (controls.toggleView === true) spectator.free = !spectator.free;
  const living = watchable(game);
  if (spectator.free || living.length === 0) {
    spectator.at = within(game, {
      x: from.x + controls.move.x * config.speed * dt,
      y: from.y + controls.move.y * config.speed * dt,
    });
  } else {
    const count = living.length;
    const known = living.findIndex(
      (player) => player.id === spectator.watching,
    );
    let index = known === -1 ? 0 : known;
    if (known !== -1 && controls.use) index = (index + 1) % count;
    else if (known !== -1 && controls.secondary)
      index = (index - 1 + count) % count;
    const watched = living[index] ?? local;
    spectator.watching = watched.id;
    spectator.at = { x: watched.x, y: watched.y };
  }
  local.x = spectator.at.x;
  local.y = spectator.at.y;
}

/**
 * Whether the camera turns with, and zooms to fit, what `eye` shows, with the rotating camera on.
 * A ghost's free camera does neither: it stays upright, the world's up at the top, at the zoom its
 * wheel sets. Watching a player, the view turns with them as it would for them.
 */
export function eyeTurns(eye: Eye): boolean {
  return eye.kind !== "free";
}

/** What the local player's client shows now. */
export function eyeOf(spectator: Spectator, game: Session): Eye {
  if (!isGhost(game.local) || spectator.at === null) return { kind: "self" };
  const watched =
    spectator.watching === null
      ? undefined
      : game.players.get(spectator.watching);
  if (spectator.free || watched === undefined || isGhost(watched))
    return { kind: "free", at: spectator.at };
  return { kind: "watch", player: watched };
}
