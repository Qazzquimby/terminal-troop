import { z } from "zod";
import { effect } from "./actions.js";
import { arrivalPoint } from "./arrival.js";
import { removeEntity } from "./entities.js";
import { isGhost } from "./ghosts.js";
import { setPlayerHealth } from "./health.js";
import { snapPrevious } from "./interpolation.js";
import { itemsOf, takeItem } from "./inventories.js";
import type { ItemState } from "./inventory.js";
import { itemInstances } from "./item-instances.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { alter } from "./steering.js";
import { eject } from "./vehicle.js";
import type { VoiceChannel } from "./voice-routes.js";
import { worldData } from "./world-data.js";
import { itemsCanLie, soundDrop, spawnWorldItem } from "./world-items.js";

/*
 * A player whose health runs out drops everything it carried round where it stood, and its body
 * lies there as an item, its corpse, which anyone can carry. Its player is a ghost meanwhile
 * (see ghosts.ts). Content brings a corpse back to life, such as the cruiser does with one
 * brought to it, through `revive`.
 */

/** How dying and coming back go. Distances in pixels. */
export interface DeathConfig {
  /** Furthest from where a player falls that the items it carried land. */
  readonly scatter: number;
  /** Health a revived player comes back with. */
  readonly reviveHealth: number;
}

/** The item a fallen player's body is. Content defines it: its glyph, weight and drop sound. */
export const CORPSE_ITEM = "corpse";

/** The key a corpse keeps, in its item state, the number of the body it is. */
const BODY_KEY = "body";

/** One fallen player's body: its name as it fell, and the number its corpse keeps. */
const Body = z.object({
  name: z.string().max(64),
  tag: z.number().int().min(0),
});

/**
 * Every fallen player's body that lies as a corpse, by player id, and the number the next one
 * takes. The host keeps it, and every client holds it, so a new host goes on from it.
 */
export const bodies = worldData({
  schema: z.object({
    next: z.number().int().min(0),
    of: z.record(z.string(), Body),
  }),
  initial: { next: 0, of: {} },
});

/** The id of the player whose corpse keeps `state`; null for none, or one not known. */
function corpseOwner(
  game: Session,
  state: ItemState | undefined,
): string | null {
  const tag = state?.[BODY_KEY];
  if (typeof tag !== "number") return null;
  for (const [id, body] of Object.entries(bodies.get(game).of))
    if (body.tag === tag) return id;
  return null;
}

/** The name `item` shows: a corpse is named after whose it is. */
export function itemName(
  game: Session,
  item: {
    readonly id: string;
    readonly name: string;
    readonly state?: ItemState | undefined;
  },
): string {
  if (item.id !== CORPSE_ITEM) return item.name;
  const owner = corpseOwner(game, item.state);
  const body = owner === null ? undefined : bodies.get(game).of[owner];
  return body === undefined ? item.name : `${body.name}'s corpse`;
}

/** How wide the flash where a player falls is, in its own radii. */
const FALL_FLASH = 2.5;

/**
 * As the host, lays `player`'s body: everything it carried lands round where it stood, each with
 * its drop sound, and its corpse lies there, with the corpse's drop sound and a flash.
 */
function fall(game: Session, player: Player): void {
  // One who falls at the wheel is put out beside the vehicle first, and falls there.
  const vehicle =
    player.ride === null ? undefined : game.entities.get(player.ride.vehicle);
  if (vehicle !== undefined) eject(game, vehicle);
  const at = { x: player.x, y: player.y };
  const { radius } = game.config.worldItems;
  // A world with no items has nothing to drop, and no corpse to lie.
  const lies = itemsCanLie(game);
  itemsOf(game, player.id).forEach((item, slot) => {
    if (!lies || item === null || !takeItem(game, player.id, slot, item.id))
      return;
    const spot = arrivalPoint(
      game.world,
      at,
      radius,
      game.config.death.scatter,
      Math.random,
    );
    const lying = spawnWorldItem(game, spot, item.id, item.left, item.state);
    soundDrop(game, item.id, spot, lying);
  });
  const held = bodies.get(game);
  bodies.set(game, {
    next: held.next + 1,
    of: { ...held.of, [player.id]: { name: player.name, tag: held.next } },
  });
  if (!lies) return;
  const corpse = spawnWorldItem(game, at, CORPSE_ITEM, undefined, {
    [BODY_KEY]: held.next,
  });
  const sound = game.itemDefinitions.get(CORPSE_ITEM)?.drop;
  effect(
    game,
    {
      at,
      ...(sound !== undefined && { sound }),
      flash: { radius: player.radius * FALL_FLASH, hit: true },
    },
    corpse,
  );
}

/**
 * As the host, each step: every player whose health has run out, and whose body does not yet lie
 * anywhere, falls. Going by the record, a host that takes over lays any body the last one missed.
 */
export function layBodies(game: Session): void {
  if (!game.hosting) return;
  const { of } = bodies.get(game);
  for (const player of game.players.values())
    if (isGhost(player) && of[player.id] === undefined) fall(game, player);
}

/** Takes every corpse of player `id` out of the world, wherever it is. */
function takeCorpses(game: Session, id: string): void {
  for (const instance of itemInstances(game, CORPSE_ITEM)) {
    if (corpseOwner(game, instance.state) !== id) continue;
    const { place } = instance;
    if ("lying" in place) removeEntity(game, place.lying.id);
    else takeItem(game, place.carrier.id, place.slot, CORPSE_ITEM);
  }
}

/**
 * As the host, brings the ghost of the player whose corpse keeps `state` back to life by `at`:
 * its corpse is gone, wherever it was, and the player stands near `at` with the configured health.
 * Returns the player revived; null when the corpse is nobody's, or its player is not in the
 * session or not a ghost.
 */
export function revive(
  game: Session,
  state: ItemState | undefined,
  at: Point,
): Player | null {
  const id = corpseOwner(game, state);
  const player = id === null ? undefined : game.players.get(id);
  if (!game.hosting || player === undefined || !isGhost(player)) return null;
  takeCorpses(game, player.id);
  const held = bodies.get(game);
  bodies.set(game, {
    ...held,
    of: Object.fromEntries(
      Object.entries(held.of).filter(([owner]) => owner !== player.id),
    ),
  });
  setPlayerHealth(game, player, game.config.death.reviveHealth);
  const spot = arrivalPoint(
    game.world,
    at,
    player.radius,
    game.config.arrival.spread,
    Math.random,
  );
  alter(game, player, (revived) => {
    revived.x = spot.x;
    revived.y = spot.y;
    revived.vx = 0;
    revived.vy = 0;
    revived.dash = null;
  });
  snapPrevious(player);
  player.tx = player.x;
  player.ty = player.y;
  return player;
}

/**
 * How ghosts are heard: a ghost hears every other ghost wherever it is, as if beside it, and no
 * living player hears a ghost at all. A ghost hears the living through the air as anyone does.
 */
export const ghostVoices: VoiceChannel = {
  routes: (_game, speaker, listener) =>
    isGhost(speaker) && isGhost(listener) ? [{ at: null, via: "air" }] : [],
  silences: (_game, speaker, listener) =>
    isGhost(speaker) && !isGhost(listener),
};
