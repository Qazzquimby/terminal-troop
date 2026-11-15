import { minBy } from "lodash-es";
import { z } from "zod";
import { defineAction } from "./actions.js";
import { footprintOf } from "./bodies.js";
import { nearestFreePoint } from "./collision.js";
import { driverOf, vehicleOf } from "./driving.js";
import type { CabinCommand, Ride } from "./driving.js";
import type { WorldEntity } from "./entities.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { gapTo, reachAlong } from "./shape.js";
import { alter } from "./steering.js";

/** Least time between one player's getting in or out, or taking or leaving the wheel, in sim seconds. */
const COOLDOWN = 0.3;

/** Least time between two honks of one player's, in sim seconds. */
const HONK_COOLDOWN = 0.4;

/** Gap, in pixels, between a vehicle's body and a player getting out beside it. */
const STEP_OUT = 4;

/** Whether `player` may get in the vehicle `id` now: beside it, on foot, and the vehicle lets it. */
function mayBoard(game: Session, player: Player, id: string): boolean {
  const found = vehicleOf(game, id);
  if (found === null || player.ride !== null) return false;
  const { entity, spec } = found;
  const gap = gapTo(footprintOf(game, entity), player);
  if (gap > player.radius + spec.reach) return false;
  return spec.canBoard?.(game, entity) ?? true;
}

/** `player`'s ride in `entity`, pointing the way it points, at rest, at the wheel or not. */
function seat(
  game: Session,
  player: Player,
  entity: WorldEntity,
  driving: boolean,
): void {
  const found = vehicleOf(game, entity.id);
  if (found === null) return;
  const ride: Ride = {
    vehicle: entity.id,
    driving,
    heading: found.spec.heading(entity),
    speed: 0,
    turn: 0,
  };
  alter(game, player, (rider) => {
    Object.assign(rider, {
      x: entity.x,
      y: entity.y,
      vx: 0,
      vy: 0,
      dash: null,
      ride,
    });
  });
}

/**
 * A player getting in a vehicle beside it, off the wheel. The host takes it if the player may get
 * in there, as `mayBoard` says; the player goes to where the vehicle is, shut inside it.
 */
const board = defineAction("board", {
  input: z.object({ id: z.string().min(1).max(80) }),
  cooldown: COOLDOWN,
  check: (game, player, { id }) => mayBoard(game, player, id),
  apply(game, player, { id }) {
    const found = vehicleOf(game, id);
    if (found !== null) seat(game, player, found.entity, false);
  },
});

/** A player inside a vehicle taking its wheel, while no one else has it; from then its steps drive it. */
const takeWheel = defineAction("wheel", {
  input: z.object({}),
  cooldown: COOLDOWN,
  check: (game, player) =>
    player.ride !== null &&
    !player.ride.driving &&
    driverOf(game, player.ride.vehicle) === null,
  apply(game, player) {
    const found =
      player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
    if (found !== null) seat(game, player, found.entity, true);
  },
});

/** Lets go of the wheel of the vehicle `player` drives, staying inside; the vehicle stops where it is. */
function letGo(game: Session, player: Player): void {
  const { ride } = player;
  if (ride?.driving !== true) return;
  alter(game, player, (rider) => {
    Object.assign(rider, {
      vx: 0,
      vy: 0,
      ride: { ...ride, driving: false, speed: 0, turn: 0 },
    });
  });
}

/** A player at the wheel letting go of it, staying inside. */
const leaveWheel = defineAction("unwheel", {
  input: z.object({}),
  cooldown: COOLDOWN,
  check: (_game, player) => player.ride?.driving === true,
  apply(game, player) {
    letGo(game, player);
  },
});

/**
 * Where `player`, inside a vehicle, gets out: beside the vehicle on its left, or the free spot
 * nearest there; where it is when the vehicle is not here.
 */
function stepOut(game: Session, player: Player): { x: number; y: number } {
  const { ride } = player;
  const found = ride === null ? null : vehicleOf(game, ride.vehicle);
  if (found === null || ride === null) return { x: player.x, y: player.y };
  // Off the wheel, the vehicle points as its record has it; at the wheel, as its driver drove it.
  const heading = ride.driving
    ? ride.heading
    : found.spec.heading(found.entity);
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

/** Takes `player` out of the vehicle it is in, beside it, at rest, as part of its step. */
function alight(game: Session, player: Player): void {
  if (player.ride === null) return;
  const at = stepOut(game, player);
  alter(game, player, (walker) => {
    Object.assign(walker, { ...at, vx: 0, vy: 0, dash: null, ride: null });
  });
}

/** A player getting out of the vehicle it is in, beside it. */
const leave = defineAction("leave", {
  input: z.object({}),
  cooldown: COOLDOWN,
  check: (_game, player) => player.ride !== null,
  apply(game, player) {
    alight(game, player);
  },
});

/** A player inside a vehicle sounding its horn, at the wheel or not. */
const honk = defineAction("honk", {
  input: z.object({}),
  cooldown: HONK_COOLDOWN,
  check: (_game, player) => player.ride !== null,
  apply(game, player) {
    const found =
      player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
    if (found === null) return;
    found.spec.honk?.(game, found.entity, player);
  },
});

/** Getting in and out of vehicles, and what is done inside, sent under the engine's own entry. */
export const vehicleActions = [
  board,
  takeWheel,
  leaveWheel,
  leave,
  honk,
] as const;

/**
 * As the host, takes the wheel from whoever drives `vehicle`, as when it breaks down under them:
 * they stay inside. Does nothing on any other client, or when no one drives it.
 */
export function unseat(game: Session, vehicle: WorldEntity): void {
  if (!game.hosting) return;
  const driver = driverOf(game, vehicle.id);
  if (driver !== null) letGo(game, driver);
}

/**
 * As the host, puts `player` out of the vehicle it is in, beside it, as when it falls there.
 * Does nothing on any other client, or for a player on foot.
 */
export function putOut(game: Session, player: Player): void {
  if (game.hosting) alight(game, player);
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
 * The local player's interaction with vehicles: inside one, from its cabin it takes the wheel,
 * and at the wheel it lets go, back to the cabin; on foot, it gets into the nearest it may.
 * Returns whether it had one to act on.
 */
export function useVehicle(game: Session): boolean {
  const { ride } = game.local;
  if (ride !== null) {
    if (ride.driving) leaveWheel.perform(game, {});
    else takeWheel.perform(game, {});
    return true;
  }
  const vehicle = boardable(game);
  if (vehicle === null) return false;
  board.perform(game, { id: vehicle.id });
  return true;
}

/** Does what the local player, inside a vehicle, asks of it from its cabin. */
export function cabinCommand(game: Session, command: CabinCommand): void {
  if (game.local.ride === null) return;
  switch (command) {
    case "drive":
      if (!game.local.ride.driving) takeWheel.perform(game, {});
      return;
    case "honk":
      honk.perform(game, {});
      return;
    case "exit":
      leave.perform(game, {});
      return;
  }
}
