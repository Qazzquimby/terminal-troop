import { z } from "zod";
import { playerData } from "./player-data.js";

/** A player's gait. */
const MovementMode = z.enum(["walk", "sprint", "crouch"]);

export type MovementMode = z.output<typeof MovementMode>;

/** How a player moves: its gait, and whether it is moving at all. */
const Movement = z.object({ mode: MovementMode, moving: z.boolean() });

/**
 * How each player moves: the local player's as of its last step, a remote player's as it last
 * reported.
 */
export const movement = playerData<z.output<typeof Movement>>({
  schema: Movement,
  initial: () => ({ mode: "walk", moving: false }),
});
