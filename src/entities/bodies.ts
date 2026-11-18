import {
  asEntity,
  effect,
  eyesOf,
  hasKindTag,
  hurtSinceLastStep,
  inCone,
  inView,
  livingBodies,
  livingBody,
} from "../sim/index.js";
import type {
  Body,
  Eyes,
  Point,
  Session,
  Sight,
  Sound,
  Strike,
  WorldEntity,
} from "../sim/index.js";
import { avenged, NEVER_PREY, preyNear, strikeEach } from "./hunt.js";
import type { Hunting, Prey } from "./hunt.js";
import { kindsAsRareAs } from "./spawning.js";

/**
 * The living body that hurt `self` since its last step, as one it would turn on: none for one it
 * spares, itself or no one; null for none.
 */
export function hitterOf(
  game: Session,
  self: { readonly id: string },
  hunting: Pick<Hunting, "targets">,
): Body | null {
  const hurt = hurtSinceLastStep(game, self.id);
  return livingBody(game, avenged(game, self, hurt?.by ?? null, hunting));
}

/**
 * Eyes as a player's, down `facing`: its view cone and surroundings, both out to `range`. For a
 * kind that sees as a person does, only not as far.
 */
export function facingEyes(facing: number, game: Session, range: number): Eyes {
  const { coneAngle, surroundingsRadius } = game.config.vision;
  return {
    cone: { direction: facing, angle: coneAngle, range },
    around: Math.min(surroundingsRadius, range),
  };
}

/** A blow of `damage` on whatever `self` touches that it does not ignore, when it is `attacking`. */
export function touchStrikes(
  game: Session,
  self: WorldEntity,
  attacking: boolean,
  ignores: readonly string[],
  damage: number,
): Strike[] {
  if (!attacking) return [];
  return strikeEach(touching(game, self, ignores), damage);
}

/**
 * A kind's `strikes`: a blow of its config's `damage` on whatever it touches that it does not
 * ignore, on each step its state is `attacking`. For any kind that strikes by touch alone.
 */
export function strikesOnTouch(config: {
  readonly ignores: readonly string[];
  readonly damage: number;
}): (
  self: WorldEntity,
  state: { readonly attacking: boolean },
  game: Session,
) => Strike[] {
  return (self, state, game) =>
    touchStrikes(game, self, state.attacking, config.ignores, config.damage);
}

/**
 * Plays, as the host, on every client, each of `made` that is a sound, where `self` stands; each
 * also makes its noise. For a kind's cue, which lists its sounds as `step && sound`.
 */
export function playEach(
  game: Session,
  self: WorldEntity,
  made: readonly (Sound | false)[],
): void {
  for (const sound of made)
    if (sound !== false)
      effect(game, { at: { x: self.x, y: self.y }, sound }, self);
}

/**
 * Has `self`, as the host, say one of `lines` picked at random aloud in `voice`, the speech
 * config's id for it: heard from it on every client, and a voice's noise as far. Says nothing with
 * no lines.
 */
export function sayOneOf(
  game: Session,
  self: WorldEntity,
  lines: readonly string[],
  voice: string,
): void {
  const text = lines[Math.floor(Math.random() * lines.length)];
  if (text === undefined) return;
  effect(game, { at: { x: self.x, y: self.y }, say: { text, voice } }, self);
}

/*
 * Who a monster hunts. Players are bodies like any other: a monster hunts, notices, chases and
 * strikes any living body, player or world entity, but itself, what `NEVER_PREY` names (inert
 * things, items lying about, unnoticed bodies such as the snail), and the kinds its config tells it
 * to ignore, its own kind by default. A kind whose config names `targets` hunts only bodies of
 * those kind tags, though it still strikes whatever it touches. Nor does it find a body only some
 * other body perceives, as the ghost girl, there to hunt or strike at all.
 */

/**
 * Every living body `self` may hunt, null for a hunter yet to arrive: players and world entities
 * alike, but itself, what `NEVER_PREY` names, those of the kind tags `hunting` ignores,
 * and, when `hunting` names targets, those of none of them.
 */
export function preyFor(
  game: Session,
  self: { readonly id: string } | null,
  hunting: Hunting,
): Body[] {
  const passed = [...hunting.ignores, ...NEVER_PREY];
  const { targets } = hunting;
  return livingBodies(game, self?.id ?? null).filter(
    (body) =>
      body.id !== self?.id &&
      !hasKindTag(game, body.id, passed) &&
      (targets === undefined || hasKindTag(game, body.id, targets)),
  );
}

/** Of `bodies`, the one nearest `at` within `range`; null for none. */
function nearestWithin<T extends Point>(
  at: Point,
  bodies: readonly T[],
  range: number,
): T | null {
  let best: T | null = null;
  let bestDistance = range;
  for (const body of bodies) {
    const distance = Math.hypot(body.x - at.x, body.y - at.y);
    if (distance <= bestDistance) {
      best = body;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The nearest body `self` may hunt within `range` if given, walls or no walls, or null: for kinds
 * that feel or know where their prey is rather than see it.
 */
export function nearestPrey(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body | null {
  return nearestWithin(self, preyFor(game, self, hunting), range);
}

/**
 * Every body `self` may hunt that it sees with its kind's eyes, within `range` if given, along a
 * clear line. A stunned or blind entity sees none.
 */
export function seenPrey(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body[] {
  const sight = eyesOf(game, self);
  if (sight === null) return [];
  return preyFor(game, self, hunting).filter((body) =>
    inView(game, sight, body, range),
  );
}

/**
 * The nearest body `self` may hunt that it sees with its kind's eyes, within `range` if given,
 * along a clear line, or null.
 */
export function nearestSeenBody(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body | null {
  const sight = eyesOf(game, self);
  if (sight === null) return null;
  let nearest: Body | null = null;
  let nearestDistance = range;
  for (const body of preyFor(game, self, hunting)) {
    const distance = Math.hypot(body.x - self.x, body.y - self.y);
    if (distance > nearestDistance) continue;
    if (!inView(game, sight, body, range)) continue;
    nearest = body;
    nearestDistance = distance;
  }
  return nearest;
}

/**
 * Every body touching `self` that it may hunt: players and world entities alike, but itself,
 * what `NEVER_PREY` names, and those of the kind tags in `ignores`.
 */
export function touching(
  game: Session,
  self: WorldEntity,
  ignores: readonly string[],
): Prey[] {
  return preyNear(game, self, (prey) => self.radius + prey.radius + 1, [
    ...ignores,
    ...NEVER_PREY,
  ]);
}

/** A ring `width` thick round `body`, `colour`ed, `gap` further out than it usually stands. */
export function drawRing(
  ctx: CanvasRenderingContext2D,
  body: Point & { readonly radius: number },
  colour: string,
  width: number,
  gap: number,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(body.x, body.y, body.radius + 2 + gap, 0, Math.PI * 2);
  ctx.stroke();
}

/** Whose gaze holds a kind back, and how far down a body's view cone it reaches. */
export interface Watching extends Hunting {
  /**
   * When given, the only kind tags whose gaze it heeds: "player" heeds players' eyes alone.
   * Absent, any body's gaze but the kinds it ignores.
   */
  readonly watchedBy?: readonly string[];
  /**
   * How far down a body's view cone it counts as watched, light or no light: as far as that body
   * looks, but never past this.
   */
  readonly watchRange: number;
  /**
   * How far past either edge of a body's view cone it still counts as watched, in radians: a
   * body glancing just off it still has it, so it does not start and stop at the cone's edge.
   */
  readonly watchMargin: number;
}

/**
 * Whether a kind watching as `watching` says heeds `body`'s gaze: it is of the kinds `watchedBy`
 * names, or with none named of any kind but those it ignores.
 */
export function heeds(
  game: Session,
  body: { readonly id: string },
  { ignores, watchedBy }: Watching,
): boolean {
  if (hasKindTag(game, body.id, ignores)) return false;
  return watchedBy === undefined || hasKindTag(game, body.id, watchedBy);
}

/**
 * The eyes of every living body whose gaze `self` heeds, as they are now: those of the kinds
 * `watchedBy` names, or with none named any body but the kinds it ignores. A stunned or blind body
 * has none, nor one with no view cone.
 */
export function watchers(
  game: Session,
  self: { readonly id: string },
  watching: Watching,
): Sight[] {
  const sights: Sight[] = [];
  for (const body of livingBodies(game)) {
    if (body.id === self.id || !heeds(game, body, watching)) continue;
    const sight = eyesOf(game, body);
    if (sight !== null && sight.cone !== null) sights.push(sight);
  }
  return sights;
}

/**
 * Whether any living body whose gaze `self` heeds, as `watchers` has them, watches a point: it
 * lies within that body's view cone, widened by the watch margin each side, as far as it looks but
 * no further than the watch range, with nothing in the way. Light plays no part, nor what lies
 * behind a body. Make one per step: the bodies' eyes are taken as they stand when it is made.
 */
export function gazeOn(
  game: Session,
  self: { readonly id: string },
  watching: Watching,
): (at: Point) => boolean {
  const widened = watchers(game, self, watching).map((sight) =>
    sight.cone === null
      ? sight
      : {
          ...sight,
          cone: {
            ...sight.cone,
            angle: sight.cone.angle + watching.watchMargin * 2,
          },
        },
  );
  return (at) =>
    widened.some((sight) => inCone(game, sight, at, watching.watchRange));
}

/**
 * Whether `body` can be killed: a player, or a world entity whose kind has a finite health. Not the
 * snail, the statue, the cruiser nor anything else nothing can wear down.
 */
export function isKillable(game: Session, body: Body): boolean {
  const entity = asEntity(game, body);
  if (entity === null) return true;
  const kind = game.entityTypes.get(entity.kind);
  return kind !== undefined && Number.isFinite(kind.maxHealth);
}

/** What a kind runs from, which its config says. */
export interface Fearing {
  /**
   * The measure it fears by: "rarity", the kinds the world's spawner brings as rarely as
   * `asRareAs` or more rarely; "toughness", any body whose full health is `toughness` or more.
   */
  readonly by: "rarity" | "toughness";
  /**
   * By rarity, it fears the kinds the world's spawner brings this rarely or more rarely: those
   * whose spawning weight is at most this.
   */
  readonly asRareAs: number;
  /** By toughness, it fears any body whose full health is at least this. */
  readonly toughness: number;
}

/** Whether a body is one `fearing` fears, by the measure it names. */
function fears(game: Session, fearing: Fearing): (body: Body) => boolean {
  if (fearing.by === "toughness")
    return (body) => body.maxHealth >= fearing.toughness;
  const kinds = kindsAsRareAs(game, fearing.asRareAs);
  return (body) => kinds.length > 0 && hasKindTag(game, body.id, kinds);
}

/**
 * Every living body `self` fears that it sees with its kind's eyes: those `fearing` names, by
 * rarity or by toughness, but the kind tags in `ignores`. A stunned or blind entity sees none.
 */
export function seenFeared(
  game: Session,
  self: WorldEntity,
  fearing: Fearing,
  ignores: readonly string[],
): Body[] {
  const sight = eyesOf(game, self);
  if (sight === null) return [];
  const isFeared = fears(game, fearing);
  return livingBodies(game, self.id).filter(
    (body) =>
      body.id !== self.id &&
      isFeared(body) &&
      !hasKindTag(game, body.id, ignores) &&
      inView(game, sight, body),
  );
}
