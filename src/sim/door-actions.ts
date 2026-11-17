import { z } from "zod";
import { defineAction } from "./actions.js";
import { doorById, doorwayBlocked, hingeOf } from "./doors.js";
import type { WorldEntity } from "./entities.js";
import type { Session } from "./session.js";

/* Players working doors: the swing action, and the interact control choosing the door. */

/** Slack on a player's reach to a door, as the host checks it, for the way it moved since. */
const REACH_SLACK = 1.5;

/** Least time between two swings of a door by one player, in sim seconds. */
const SWING_COOLDOWN = 0.3;

/**
 * A player opening the door `id` within its reach, or closing it when nothing stands in its
 * doorway.
 */
const swingDoor = defineAction("swing", {
  input: z.object({ id: z.string() }),
  cooldown: SWING_COOLDOWN,
  check(game, player, { id }) {
    const found = doorById(game, id);
    if (found === null) return false;
    const { door, hinge } = found;
    const distance = Math.hypot(door.x - player.x, door.y - player.y);
    if (distance > hinge.reach * REACH_SLACK) return false;
    return hinge.closed(door) || !doorwayBlocked(game, door);
  },
  apply(game, player, { id }) {
    const found = doorById(game, id);
    if (found === null) return;
    const { door, hinge } = found;
    const close = !hinge.closed(door);
    if (close && doorwayBlocked(game, door)) return;
    hinge.swing(game, door, close, player.id);
  },
});

export const doorActions = [swingDoor] as const;

/**
 * The local player opens or closes the nearest door within its reach. Returns whether it had one
 * to work.
 */
export function useDoor(game: Session): boolean {
  const { local } = game;
  let nearest: WorldEntity | null = null;
  let best = Infinity;
  for (const entity of game.entities.values()) {
    const hinge = hingeOf(game, entity);
    if (hinge === null) continue;
    const distance = Math.hypot(entity.x - local.x, entity.y - local.y);
    if (distance <= hinge.reach && distance < best) {
      nearest = entity;
      best = distance;
    }
  }
  if (nearest === null) return false;
  swingDoor.perform(game, { id: nearest.id });
  return true;
}
