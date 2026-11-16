import { bodyById, destroyWalls, effect, hurt } from "../sim/index.js";
import type { Session, Sound, WorldEntity } from "../sim/index.js";
import { preyNear } from "./hunt.js";

/**
 * A burst: how far it reaches, in pixels, and the damage it deals to a body where it goes off and
 * to one at its edge, falling evenly between. Any kind that goes off, an exploder or a land mine,
 * declares one.
 */
export interface Blast {
  readonly radius: number;
  readonly centre: number;
  readonly edge: number;
}

/** The damage `blast` deals to a body `distance` from where it goes off, its middle to theirs. */
export function blastDamage(distance: number, blast: Blast): number {
  const { radius, centre, edge } = blast;
  const along = Math.min(1, Math.max(0, distance / radius));
  return centre + (edge - centre) * along;
}

/** How a burst shows itself and what else it does. */
interface Detonation {
  /** Its bang, heard, and making a noise, out to its range. */
  readonly sound: Sound;
  /** Whether it knocks down the walls it reaches. */
  readonly walls: boolean;
}

/**
 * Sets `blast` off where `source` stands, as the host: sounds and shows the burst on every client,
 * knocks down the walls it reaches if it does, and hurts every body it reaches, players and world
 * entities alike, but `source` itself and items lying about, by how near it is, down to `source`.
 */
export function detonate(
  game: Session,
  source: WorldEntity,
  blast: Blast,
  made: Detonation,
): void {
  const { radius } = blast;
  const at = { x: source.x, y: source.y };
  if (made.walls) destroyWalls(game, { center: at, radius });
  effect(
    game,
    { at: source, sound: made.sound, flash: { radius, hit: true } },
    source,
  );
  const reach = (body: { readonly radius: number }) => radius + body.radius;
  for (const body of preyNear(game, source, reach, [])) {
    const distance = Math.hypot(body.x - at.x, body.y - at.y);
    const caught = bodyById(game, body.id);
    if (caught !== null)
      hurt(game, caught, blastDamage(distance, blast), source.id);
  }
}
