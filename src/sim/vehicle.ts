import { minBy } from "lodash-es";
import { z } from "zod";
import { defineAction } from "./actions.js";
import { footprintOf } from "./bodies.js";
import { nearestFreePoint } from "./collision.js";
import { driverOf, vehicleOf } from "./driving.js";
import type { WorldEntity } from "./entities.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { gapTo, reachAlong } from "./shape.js";
import { alter } from "./steering.js";

/** Least time between one player's getting in or out, in sim seconds. */
const COOLDOWN = 0.3;

/** Gap, in pixels, between a vehicle's body and a player getting out beside it. */
const STEP_OUT = 4;

/** Whether `player` may get in the vehicle `id` now: beside it, on foot, and no one else at its wheel. */
function mayBoard(game: Session, player: Player, id: string): boolean {
  const found = vehicleOf(game, id);
  if (found === null || player.ride !== null) return false;
  const { entity, spec } = found;
  const gap = gapTo(footprintOf(game, entity), player);
  if (gap > player.radius + spec.reach) return false;
  if (driverOf(game, id) !== null) return false;
  return spec.canBoard?.(game, entity) ?? true;
}

/**
 * A player taking the wheel of a vehicle beside it. The host takes it if the player may get in
 * there, as `mayBoard` says; the player goes to where the vehicle is, at rest, pointing the way
 * the vehicle points, and from then its steps drive it.
 */
const board = defineAction("board", {
  input: z.object({ id: z.string().min(1).max(80) }),
  cooldown: COOLDOWN,
  check: (game, player, { id }) => mayBoard(game, player, id),
  apply(game, player, { id }) {
    const found = vehicleOf(game, id);
    if (found === null) return;
    const { entity, spec } = found;
    const ride = { vehicle: id, heading: spec.heading(entity), speed: 0 };
    alter(game, player, (driver) => {
      Object.assign(driver, {
        x: entity.x,
        y: entity.y,
        vx: 0,
        vy: 0,
        dash: null,
        ride,
      });
    });
  },
});

/**
 * Where `player`, at the wheel, gets out: beside the vehicle on its left, or the free spot
 * nearest there; where it is when the vehicle is not here.
 */
function stepOut(game: Session, player: Player): { x: number; y: number } {
  const found =
    player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
  if (found === null || player.ride === null)
    return { x: player.x, y: player.y };
  const { heading } = player.ride;
  const side = heading - Math.PI / 2;
  const { box, ...disc } = footprintOf(game, found.entity);
  const body =
    box === null || box === undefined
      ? disc
      : { ...disc, box: { ...box, heading } };
  const out = { x: Math.cos(side), y: Math.sin(side) };
  const gap = reachAlong(body, out) + player.radius + STEP_OUT;
  return nearestFreePoint(game.world.map, player.radius, {
    x: player.x + Math.cos(side) * gap,
    y: player.y + Math.sin(side) * gap,
  });
}

/** Takes `player` out of the vehicle it drives, beside it, at rest, as part of its step. */
function alight(game: Session, player: Player): void {
  if (player.ride === null) return;
  const at = stepOut(game, player);
  alter(game, player, (walker) => {
    Object.assign(walker, { ...at, vx: 0, vy: 0, dash: null, ride: null });
  });
}

/** A player getting out of the vehicle it drives, beside it. */
const leave = defineAction("leave", {
  input: z.object({}),
  cooldown: COOLDOWN,
  check: (_game, player) => player.ride !== null,
  apply(game, player) {
    alight(game, player);
  },
});

/** Getting in and out of vehicles, sent under the engine's own entry. */
export const vehicleActions = [board, leave] as const;

/**
 * As the host, puts whoever drives `vehicle` out beside it, as when it breaks down under them.
 * Does nothing on any other client, or when no one drives it.
 */
export function eject(game: Session, vehicle: WorldEntity): void {
  if (!game.hosting) return;
  const driver = driverOf(game, vehicle.id);
  if (driver !== null) alight(game, driver);
}

/** The vehicle the local player may get in now, nearest first; null for none. */
function boardable(game: Session): WorldEntity | null {
  const { local } = game;
  const near = [...game.entities.values()].filter((entity) =>
    mayBoard(game, local, entity.id),
  );
  return (
    minBy(near, (entity) =>
      Math.hypot(entity.x - local.x, entity.y - local.y),
    ) ?? null
  );
}

/**
 * The local player's interaction with vehicles: out of the one it drives, or into the nearest it
 * may get in. Returns whether it had one to act on.
 */
export function useVehicle(game: Session): boolean {
  if (game.local.ride !== null) {
    leave.perform(game, {});
    return true;
  }
  const vehicle = boardable(game);
  if (vehicle === null) return false;
  board.perform(game, { id: vehicle.id });
  return true;
}
