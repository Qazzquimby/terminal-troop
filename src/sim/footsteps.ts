import { movement } from "./movement.js";
import type { MovementMode } from "./movement.js";
import { emitNoise } from "./noise.js";
import type { Session } from "./session.js";

/** The footsteps of one gait. */
interface Footstep {
  /** Seconds between steps while moving. */
  readonly interval: number;
  /** How far each step carries, in pixels. */
  readonly radius: number;
}

/** Each gait's footsteps. */
export type FootstepConfig = Readonly<Record<MovementMode, Footstep>>;

/**
 * Makes each moving player's footsteps for a step of `dt`: one as it starts moving, then one
 * each interval of its gait. A player standing still makes none.
 */
export function emitFootsteps(game: Session, dt: number): void {
  for (const player of game.players.values()) {
    const { mode, moving } = movement.get(player);
    if (!moving) {
      player.stride = 0;
      continue;
    }
    player.stride -= dt;
    if (player.stride > 0) continue;
    const footstep = game.config.footsteps[mode];
    player.stride = footstep.interval;
    emitNoise(game, {
      at: { x: player.x, y: player.y },
      radius: footstep.radius,
      source: player.id,
    });
  }
}
