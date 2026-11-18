import type { Kinetic } from "./collision.js";
import type { Interpolated, Tracked } from "./interpolation.js";
import type { Session } from "./session.js";

/**
 * A safety net for a body whose position or velocity goes NaN or infinite, through a bad divide
 * in any content: loops over the cells a body spans would never end. The step puts such a body
 * back where it began the step, still, and says so once per kind each session.
 */

type Guarded = Kinetic & Interpolated & Tracked;

/** The kinds each session has warned of already. */
const warned = new WeakMap<Session, Set<string>>();

const isFiniteBody = (body: Kinetic): boolean =>
  Number.isFinite(body.x) &&
  Number.isFinite(body.y) &&
  Number.isFinite(body.vx) &&
  Number.isFinite(body.vy);

function warnOnce(game: Session, kind: string, body: Kinetic): void {
  let kinds = warned.get(game);
  if (kinds === undefined) {
    kinds = new Set();
    warned.set(game, kinds);
  }
  if (kinds.has(kind)) return;
  kinds.add(kind);
  console.warn(
    `A ${kind} ended a move at a non-finite place or velocity, ${String([body.x, body.y, body.vx, body.vy])}; ` +
      "it is put back where it began the step.",
  );
}

/**
 * Puts `body` back where it began the step, still, when its position or velocity is not finite;
 * whether it did. `kind` names it in the warning.
 */
function restoreNonFinite(game: Session, body: Guarded, kind: string): boolean {
  if (isFiniteBody(body)) return false;
  warnOnce(game, kind, body);
  const back =
    Number.isFinite(body.prevX) && Number.isFinite(body.prevY)
      ? { x: body.prevX, y: body.prevY }
      : game.rally;
  body.x = body.tx = body.prevX = back.x;
  body.y = body.ty = body.prevY = back.y;
  body.vx = 0;
  body.vy = 0;
  body.glide = 0;
  return true;
}

/** The name an entity kind was registered under. */
function kindName(game: Session, kind: number): string {
  for (const [name, id] of game.kindIds) if (id === kind) return name;
  return `entity kind ${String(kind)}`;
}

/** As `restoreNonFinite`, for one entity, named by its kind only when it needs putting back. */
export function guardEntity(
  game: Session,
  entity: Guarded & { readonly kind: number },
): void {
  if (!isFiniteBody(entity))
    restoreNonFinite(game, entity, kindName(game, entity.kind));
}

/** Puts back every body, player or entity, that ended its move at a non-finite place or speed. */
export function guardBodies(game: Session): void {
  for (const player of game.players.values())
    restoreNonFinite(game, player, "player");
  for (const entity of game.entities.values()) guardEntity(game, entity);
}
