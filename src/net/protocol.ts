import { z } from "zod";

export const PLAYER_NAME_MAX = 8;

const PlayerId = z.string().min(1).max(64);

// z.number() rejects NaN and ±Infinity.
export const StateMessage = z.object({
  id: PlayerId,
  name: z.string().transform((name) => name.slice(0, PLAYER_NAME_MAX)),
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});

/** HELLO and BYE carry only the sender's id. */
export const PresenceMessage = z.object({ id: PlayerId });
