import { effect, teleport } from "../sim/index.js";
import type { Session, Sound, WorldEntity } from "../sim/index.js";
import { preyFor } from "./bodies.js";
import type { Hunting } from "./hunt.js";
import { arrivalPoint, watchedAt } from "./spawning.js";

/**
 * When a monster left alone moves elsewhere: with no body it hunts within `range` pixels for
 * `after` seconds, it leaves for somewhere it might have arrived, as the spawner picks it. Watched
 * where it is, or with nowhere to go, it tries again `retry` seconds on.
 */
export interface RelocateConfig {
  readonly after: number;
  readonly range: number;
  readonly retry: number;
}

/** Where a relocation stands after a step. */
export interface Relocated {
  /** When a body it hunts was last near, or as good as, so a failed try waits `retry`. */
  readonly nearAt: number;
  /** Whether it moved this step. */
  readonly moved: boolean;
}

/**
 * Notes when a body `self` hunts, by `hunting`, was last near it, and once it has gone long enough
 * with none and is `ready` to go, moves it to a point the spawner would pick for one of `kind`
 * arriving now: free ground where its kind's spawn rules let it appear (so off the road, as the
 * spawner keeps monsters), out of every player's sight. `sound` is made where it leaves and where
 * it comes. Watched where it is, or with nowhere to go, it waits `retry` seconds and tries again.
 * Every kind that wanders off when left alone goes through it, so all land where they could spawn.
 */
export function relocate(
  game: Session,
  kind: string,
  self: WorldEntity,
  nearAt: number,
  hunting: Hunting,
  config: RelocateConfig,
  sound: Sound,
  ready = true,
): Relocated {
  const now = game.worldTime;
  const { after, range, retry } = config;
  const near = preyFor(game, self, hunting, { at: self, range }).some(
    (body) => Math.hypot(body.x - self.x, body.y - self.y) <= range,
  );
  if (near) return { nearAt: now, moved: false };
  if (!ready || now - nearAt < after) return { nearAt, moved: false };
  const to = watchedAt(game, kind, self) ? null : arrivalPoint(game, kind);
  if (to === null) return { nearAt: now - after + retry, moved: false };
  effect(game, { at: { x: self.x, y: self.y }, sound }, self);
  teleport(game, self, to);
  effect(game, { at: to, sound }, self);
  return { nearAt: now, moved: true };
}
