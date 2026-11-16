import { minBy } from "lodash-es";
import { z } from "zod";
import {
  changeWorld,
  defineAction,
  effect,
  give,
  stateAt,
  take,
  usesAt,
} from "./actions.js";
import { footprintOf, livingBody } from "./bodies.js";
import type { Body } from "./bodies.js";
import { nearestFreePoint } from "./collision.js";
import { credit } from "./credit.js";
import { driverOf, vehicleOf } from "./driving.js";
import type {
  CabinCommand,
  Ride,
  Storage,
  VehicleShop,
  VehicleTeleporter,
  Ware,
} from "./driving.js";
import type { WorldEntity } from "./entities.js";
import { hasRoom, itemIn, storeOf, stores, storesWith } from "./inventories.js";
import { carried, ItemId, usesLeft, withState } from "./inventory.js";
import type { CarriedItem, Inventory } from "./inventory.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { gapTo, reachAlong } from "./shape.js";
import type { Sound } from "./sound.js";
import { alter } from "./steering.js";

/** Least time between one player's getting in or out, or taking or leaving the wheel, in sim seconds. */
const COOLDOWN = 0.3;

/** Least time between two honks of one player's, in sim seconds. */
const HONK_COOLDOWN = 0.4;

/** Least time between two turns of a vehicle's radio by one player, in sim seconds. */
const TUNE_COOLDOWN = 0.3;

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

/** Least time between one player's stowing, taking or buying, in sim seconds. */
const STOCK_COOLDOWN = 0.15;

const SlotIndex = z.number().int().min(0).max(63);

/** The vehicle `player` is in and its storage, with what it holds; null without either. */
function storageFor(
  game: Session,
  player: Player,
): {
  readonly id: string;
  readonly spec: Storage;
  readonly items: Inventory;
} | null {
  const found =
    player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
  const spec = found?.spec.storage;
  if (found === null || spec === undefined) return null;
  const { id } = found.entity;
  return { id, spec, items: storeOf(game, id, spec.slots) };
}

/** The shop of the vehicle `player` is in; null when it is in none, or one without a shop. */
function shopFor(game: Session, player: Player): VehicleShop | null {
  const found =
    player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
  return found?.spec.shop ?? null;
}

/** `slot` of `items` if it is empty, or with `slot` left out, the first empty one; null for none. */
function emptySlot(items: Inventory, slot?: number): number | null {
  if (slot !== undefined) return items[slot] === null ? slot : null;
  const index = items.indexOf(null);
  return index === -1 ? null : index;
}

/** The item `id` as new, as this client knows it; null for one it does not know. */
function fresh(game: Session, id: string): CarriedItem | null {
  return game.itemDefinitions.get(id) ?? null;
}

/** Makes the sound and noise `made` makes, where `player` is, as part of its action. */
function sounds(
  game: Session,
  player: Player,
  made: { readonly sound?: Sound; readonly noise?: number },
): void {
  effect(game, {
    at: { x: player.x, y: player.y },
    ...(made.sound !== undefined && { sound: made.sound }),
    ...(made.noise !== undefined && { noise: made.noise }),
  });
}

/**
 * A player inside a vehicle leaving the item in its own slot `slot` in the vehicle's storage: in
 * the storage's slot `into` when it is empty, or its first empty slot. The item keeps its uses
 * and state.
 */
const stow = defineAction("stow", {
  input: z.object({ slot: SlotIndex, into: SlotIndex.optional() }),
  cooldown: STOCK_COOLDOWN,
  check(game, player, { slot, into }) {
    const storage = storageFor(game, player);
    return (
      storage !== null &&
      itemIn(game, player.id, slot) !== null &&
      emptySlot(storage.items, into) !== null
    );
  },
  apply(game, player, { slot, into }) {
    const storage = storageFor(game, player);
    const at = storage === null ? null : emptySlot(storage.items, into);
    if (storage === null || at === null) return;
    const left = usesAt(game, player, slot);
    const state = stateAt(game, player, slot);
    const id = take(game, player, slot);
    const definition = id === null ? null : fresh(game, id);
    if (definition === null) return;
    const item = withState(carried(definition, left ?? undefined), state);
    changeWorld(game, stores, () =>
      storesWith(game, storage.id, storage.spec.slots, at, item),
    );
    sounds(game, player, storage.spec);
  },
});

/** A player inside a vehicle taking the item in the storage's slot `slot`, if it has room for it. */
const unstow = defineAction("unstow", {
  input: z.object({ slot: SlotIndex }),
  cooldown: STOCK_COOLDOWN,
  check(game, player, { slot }) {
    const storage = storageFor(game, player);
    return (storage?.items[slot] ?? null) !== null && hasRoom(game, player.id);
  },
  apply(game, player, { slot }) {
    const storage = storageFor(game, player);
    const item = storage?.items[slot] ?? null;
    if (storage === null || item === null) return;
    const left = usesLeft(item) ?? undefined;
    if (!give(game, player, item.id, left, item.state)) return;
    changeWorld(game, stores, () =>
      storesWith(game, storage.id, storage.spec.slots, slot, null),
    );
    sounds(game, player, storage.spec);
  },
});

/**
 * A player inside a vehicle buying the item `item` at its shop with the team's credit, if the
 * team has enough: it goes in the buyer's items, or the vehicle's storage when they are full.
 * Without room in either, it is not bought.
 */
const buy = defineAction("buy", {
  input: z.object({ item: ItemId }),
  cooldown: STOCK_COOLDOWN,
  check(game, player, { item }) {
    const ware = shopFor(game, player)?.wares.find(
      (each) => each.item === item,
    );
    if (ware === undefined || fresh(game, item) === null) return false;
    if (credit.get(game) < ware.price) return false;
    const storage = storageFor(game, player);
    return (
      hasRoom(game, player.id) ||
      (storage !== null && emptySlot(storage.items) !== null)
    );
  },
  apply(game, player, { item }) {
    const shop = shopFor(game, player);
    const ware = shop?.wares.find((each) => each.item === item);
    const bought = fresh(game, item);
    if (shop === null || ware === undefined || bought === null) return;
    if (credit.get(game) < ware.price) return;
    if (!give(game, player, item)) {
      const storage = storageFor(game, player);
      const at = storage === null ? null : emptySlot(storage.items);
      if (storage === null || at === null) return;
      changeWorld(game, stores, () =>
        storesWith(game, storage.id, storage.spec.slots, at, bought),
      );
    }
    changeWorld(game, credit, (value) => value - ware.price);
    sounds(game, player, shop);
  },
});

/** What the vehicle `vehicle`'s storage holds, slot by slot; null for one without storage. */
export function cabinStorage(game: Session, vehicle: string): Inventory | null {
  const spec = vehicleOf(game, vehicle)?.spec.storage;
  return spec === undefined ? null : storeOf(game, vehicle, spec.slots);
}

/** A vehicle's shop as its cabin shows it: what it sells, and the team's credit to buy with. */
export interface CabinShop {
  readonly wares: readonly Ware[];
  readonly credit: number;
}

/** The vehicle `vehicle`'s shop; null for one without a shop. */
export function cabinShop(game: Session, vehicle: string): CabinShop | null {
  const shop = vehicleOf(game, vehicle)?.spec.shop;
  return shop === undefined
    ? null
    : { wares: shop.wares, credit: credit.get(game) };
}

/** A player inside a vehicle turning its radio: to the next station, switching it on, or off. */
const tune = defineAction("tune", {
  input: z.object({ to: z.enum(["next", "off"]) }),
  cooldown: TUNE_COOLDOWN,
  check: (_game, player) => player.ride !== null,
  apply(game, player, { to }) {
    const found =
      player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
    if (found === null) return;
    found.spec.tune?.(game, found.entity, player, to);
  },
});

/** Least time between two of one player's sending for a body with a vehicle's teleporter, in sim seconds. */
const TELEPORT_COOLDOWN = 0.5;

/**
 * The vehicle `player` is in, its teleporter, and `target` to send for with it: a living body out
 * in the world, not the vehicle itself, while the teleporter is free. Null when any of that fails.
 */
function teleportFor(
  game: Session,
  player: Player,
  target: string,
): {
  readonly entity: WorldEntity;
  readonly teleporter: VehicleTeleporter;
  readonly body: Body;
} | null {
  const found =
    player.ride === null ? null : vehicleOf(game, player.ride.vehicle);
  const teleporter = found?.spec.teleporter;
  if (found === null || teleporter === undefined) return null;
  const body = livingBody(game, target);
  if (body === null || body.id === found.entity.id) return null;
  if (teleporter.sending(game, found.entity) !== null) return null;
  return { entity: found.entity, teleporter, body };
}

/**
 * A player inside a vehicle sending for the body `target` with the vehicle's teleporter, which
 * brings it there: any living body out in the world, while the teleporter is bringing no other.
 */
const teleport = defineAction("teleport", {
  input: z.object({ target: z.string().min(1).max(80) }),
  cooldown: TELEPORT_COOLDOWN,
  check: (game, player, { target }) =>
    teleportFor(game, player, target) !== null,
  apply(game, player, { target }) {
    const found = teleportFor(game, player, target);
    found?.teleporter.send(game, found.entity, player, found.body);
  },
});

/**
 * A vehicle's teleporter as its cabin shows it: the id of the body it is bringing now, null while
 * it is free.
 */
export interface CabinTeleporter {
  readonly sending: string | null;
}

/** The vehicle `vehicle`'s teleporter; null for one without a teleporter. */
export function cabinTeleporter(
  game: Session,
  vehicle: string,
): CabinTeleporter | null {
  const found = vehicleOf(game, vehicle);
  const teleporter = found?.spec.teleporter;
  if (found === null || teleporter === undefined) return null;
  return { sending: teleporter.sending(game, found.entity) };
}

/** Getting in and out of vehicles, and what is done inside, sent under the engine's own entry. */
export const vehicleActions = [
  board,
  takeWheel,
  leaveWheel,
  leave,
  honk,
  stow,
  unstow,
  buy,
  tune,
  teleport,
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
  if (typeof command === "object") {
    if ("stow" in command)
      stow.perform(game, {
        slot: command.stow,
        ...(command.into !== undefined && { into: command.into }),
      });
    else if ("unstow" in command)
      unstow.perform(game, { slot: command.unstow });
    else if ("teleport" in command)
      teleport.perform(game, { target: command.teleport });
    else buy.perform(game, { item: command.buy });
    return;
  }
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
    case "radio":
      tune.perform(game, { to: "next" });
      return;
    case "radioOff":
      tune.perform(game, { to: "off" });
      return;
  }
}
