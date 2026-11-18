import { doorInReach, workDoor } from "./door-actions.js";
import type { WorldEntity } from "./entities.js";
import type { Session } from "./session.js";
import { controlItemIn, heldControl } from "./use.js";
import { boardable, boardVehicle, useRide } from "./vehicle.js";
import { pickUp, pickupTarget } from "./world-items.js";

/*
 * The interact control (E): one choice of what it acts on, which both the action and its
 * highlight read, so what is shown as the target and what E does never disagree.
 */

/**
 * What the local player's interaction acts on now:
 * - ride: the vehicle it rides, taking or letting go of the wheel
 * - item: a lying item it would pick up, or a body posing as one
 * - vehicle: a vehicle it would get into
 * - door: a door it would open or close
 * - control: the control of the item it holds, in `slot`
 */
export type InteractTarget =
  | { readonly kind: "ride" }
  | { readonly kind: "item"; readonly entity: WorldEntity }
  | { readonly kind: "vehicle"; readonly entity: WorldEntity }
  | { readonly kind: "door"; readonly entity: WorldEntity }
  | { readonly kind: "control"; readonly slot: number };

/**
 * What the local player's interaction would act on now, first found: aboard, its ride; on foot,
 * the lying item it would pick up, else a vehicle it may get into, else a door within its reach,
 * else its held item's control. Null for nothing.
 */
export function interactTarget(game: Session): InteractTarget | null {
  if (game.local.ride !== null) return { kind: "ride" };
  const item = pickupTarget(game);
  if (item !== null) return { kind: "item", entity: item };
  const vehicle = boardable(game);
  if (vehicle !== null) return { kind: "vehicle", entity: vehicle };
  const door = doorInReach(game);
  if (door !== null) return { kind: "door", entity: door };
  const slot = heldControl(game);
  return slot === null ? null : { kind: "control", slot };
}

/** The world entity an interaction target stands for, to highlight; null for none. */
export function targetEntity(
  target: InteractTarget | null,
): WorldEntity | null {
  return target !== null && "entity" in target ? target.entity : null;
}

/** The local player's interaction: acts on exactly what `interactTarget` names. */
export function interact(game: Session): void {
  const target = interactTarget(game);
  if (target === null) return;
  switch (target.kind) {
    case "ride":
      useRide(game);
      return;
    case "item":
      pickUp.perform(game, { id: target.entity.id });
      return;
    case "vehicle":
      boardVehicle(game, target.entity.id);
      return;
    case "door":
      workDoor(game, target.entity.id);
      return;
    case "control":
      controlItemIn(game, target.slot);
  }
}
