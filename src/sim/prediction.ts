import { z } from "zod";
import type { WorldEntity } from "./entities.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * What a guest predicted of one entity, held against the host's snapshots: its position and
 * health stay as predicted, while the host's arrive underneath, until the host confirms the
 * action or the hold runs out.
 */
export interface Prediction {
  /** The local action the host must have handled before its snapshots take over. */
  readonly action: number;
  /** When, in sim seconds, the host's snapshots take over regardless. */
  readonly until: number;
  /** The entity's health as the host last sent it. */
  health: number;
}

/** The latest action the host has handled from each player, accepted or not, by player id. */
export const handledActions = worldData({
  schema: z.record(z.string(), z.number().int().nonnegative()),
  initial: {},
});

/** A new action by the local player: its number, for the host to confirm. Numbered from 1. */
export function nextAction(game: Session): number {
  return ++game.lastAction;
}

/**
 * Applies `effect` at once to this client's copy of each of `entities`, as the host will once it
 * handles the local player's `action`, and holds what it predicted against the host's snapshots
 * until the host confirms the action, or `net.predictionHold` passes; the entity then eases to
 * the host's position. Does nothing while hosting: the host applies the action itself.
 */
export function predict(
  game: Session,
  action: number,
  entities: readonly WorldEntity[],
  effect: (entity: WorldEntity) => void,
): void {
  if (game.hosting) return;
  for (const entity of entities) {
    hold(game, action, entity);
    effect(entity);
  }
}

/**
 * Holds `entity` as this client is about to predict what the local action `action` does to it:
 * its position and health stay as predicted against the host's snapshots until the host confirms
 * the action, or `net.predictionHold` passes.
 */
export function hold(game: Session, action: number, entity: WorldEntity): void {
  game.predictions.set(entity.id, {
    action,
    until: game.time + game.config.net.predictionHold,
    health: game.predictions.get(entity.id)?.health ?? entity.health,
  });
}

/**
 * As the host, confirms player `by`'s action `action` handled, whether it was accepted or not;
 * the confirmation travels with the next snapshot, which shows what the action did.
 */
export function confirmAction(game: Session, by: string, action: number): void {
  const handled = Object.fromEntries(
    Object.entries(handledActions.get(game)).filter(([id]) =>
      game.players.has(id),
    ),
  );
  handledActions.set(game, { ...handled, [by]: action });
}

/** Takes `health` as the host's for `entity`: shown at once, unless a prediction holds it. */
export function hearHealth(
  game: Session,
  entity: WorldEntity,
  health: number,
): void {
  const held = game.predictions.get(entity.id);
  if (held === undefined) entity.health = health;
  else held.health = health;
}

/** `entity`'s health as the host last sent it, whether or not a prediction holds it. */
export const heardHealth = (game: Session, entity: WorldEntity): number =>
  game.predictions.get(entity.id)?.health ?? entity.health;

/** Whether a prediction holds `entity`'s position against the host's snapshots. */
export const isHeld = (game: Session, entity: WorldEntity): boolean =>
  game.predictions.has(entity.id);

/**
 * Lets go of each prediction the host has confirmed, that has run out, or whose entity is gone,
 * and of every prediction once this client hosts: each entity takes the host's health, and from
 * here eases to the host's position.
 */
export function settlePredictions(game: Session): void {
  const handled = handledActions.get(game)[game.localId] ?? 0;
  for (const [id, held] of game.predictions) {
    const entity = game.entities.get(id);
    if (
      entity !== undefined &&
      !game.hosting &&
      handled < held.action &&
      game.time < held.until
    )
      continue;
    if (entity !== undefined) entity.health = held.health;
    game.predictions.delete(id);
  }
}
