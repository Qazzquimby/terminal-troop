import { z } from "zod";
import { solidBodiesBut } from "./collision.js";
import { contentEvent, registerEvents } from "./content-event.js";
import type { ContentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { applyDamage } from "./entity.js";
import { showFlash } from "./flashes.js";
import { hurtPlayer } from "./health.js";
import { knockBack } from "./knockback.js";
import type { Blocked } from "./knockback.js";
import type { Point } from "./map.js";
import { allowMove, couldStand } from "./move-checks.js";
import { emitNoise } from "./noise.js";
import type { Player } from "./player.js";
import { startDash } from "./player.js";
import { confirmAction, hold, nextAction } from "./prediction.js";
import type { Session } from "./session.js";
import { declaredSound } from "./sound.js";
import type { Sound } from "./sound.js";
import { spendStamina } from "./stamina.js";
import { hostSpends } from "./stamina-checks.js";
import { hostReady } from "./use.js";

/** Where an actor says it stood as it acted, and how far past the host's checks it may be. */
interface Stood {
  readonly at: Point;
  /** Pixels on top of what the host's checks on the actor's moves allow; none when left out. */
  readonly leeway?: number;
}

/**
 * What a player can do, as plain sim code. Times in sim seconds.
 *
 * The actor's client applies it at once, as a prediction, and sends its input to the host. The
 * host holds the actor to the stamina, position and cooldown the action declares and to its own
 * `check`, and applies it if all pass. Either way the host confirms it, and what the actor's
 * client predicted gives way to the host's state: what the host did, or nothing if it refused.
 */
export interface ActionSpec<I> {
  /** What the actor's client sends: checked, encoded for the wire and decoded back. */
  readonly input: z.ZodType<I>;
  /** Least time between two of one actor's; none when left out. */
  readonly cooldown?: number;
  /** Stamina each costs the actor; an actor with less does not act. None when left out. */
  readonly stamina?: number;
  /** Where the actor says it stood, which the host holds to its checks on the actor's moves. */
  stood?(actor: Player, input: I): Stood;
  /** Whether the host takes the input, past the declared checks; true when left out. */
  check?(game: Session, actor: Player, input: I): boolean;
  /**
   * What the action does, run on the actor's client as it acts and on the host once it accepts:
   * reads the world, and changes it through `hurt`, `push`, `dash` and `effect`.
   */
  apply(game: Session, actor: Player, input: I): void;
}

/** A player action, sent through the room under its content entry, as `name`. */
export interface Action<I> {
  readonly name: string;
  /**
   * Acts for the local player, if it is off cooldown and has the stamina: applies the action at
   * once and sends `input` to the host. Returns whether it acted.
   */
  perform(game: Session, input: I): boolean;
}

/** A flash where an effect lands: how wide, and whether it connected. */
interface Flash {
  readonly radius: number;
  readonly hit: boolean;
}

/** What an action shows and sounds, at one spot. */
export interface Effect {
  readonly at: Point;
  /** Played there for every client's listener. */
  readonly sound?: Sound;
  readonly flash?: Flash;
  /** How far, in pixels, the noise it makes carries; none when left out. */
  readonly noise?: number;
}

/**
 * How an action is being applied on this client:
 * - predict: on the actor's own client, as it acts
 * - host: on the host, once it accepts
 */
interface Run {
  readonly mode: "predict" | "host";
  readonly action: number;
  /** What the host is to send once it has applied the action. */
  readonly effects: Effect[];
}

/** The action being applied on each session, if any. */
const runs = new WeakMap<Session, Run>();

/** Each action's requests. */
const requests = new WeakMap<Action<never>, ContentEvent<unknown>>();

/** Plays `made`'s sound and shows its flash on this client. */
function play(game: Session, { at, sound, flash }: Effect): void {
  if (sound !== undefined)
    void game.sfx.play(
      sound.url,
      at,
      game.local,
      sound.volume === undefined ? {} : { volume: sound.volume },
    );
  if (flash !== undefined) showFlash(game, { at, ...flash });
}

/** An effect as it travels: its sound by url. */
const SentEffect = z.object({
  x: z.number(),
  y: z.number(),
  sound: z.string().max(512).optional(),
  flash: z.object({ radius: z.number().min(0), hit: z.boolean() }).optional(),
  noise: z.number().min(0).optional(),
});
type SentEffect = z.infer<typeof SentEffect>;

const sent = ({ at, sound, flash, noise }: Effect): SentEffect => ({
  x: at.x,
  y: at.y,
  ...(sound !== undefined && { sound: sound.url }),
  ...(flash !== undefined && { flash }),
  ...(noise !== undefined && { noise }),
});

/** `effect` as it arrived; a sound no content declared plays nothing. */
function arrived({ x, y, sound, flash, noise }: SentEffect): Effect {
  const declared = sound === undefined ? undefined : declaredSound(sound);
  return {
    at: { x, y },
    ...(declared !== undefined && { sound: declared }),
    ...(flash !== undefined && { flash }),
    ...(noise !== undefined && { noise }),
  };
}

/**
 * The effects of an action the host applied, sent to every client, the host's own included: each
 * plays them but the actor's, which played them as it acted, and each makes their noise.
 */
const effected = contentEvent({
  schema: z.object({
    by: z.string().min(1).max(64),
    effects: z.array(SentEffect).max(32),
  }),
  to: "all",
  from: "host",
  receive(game, { by, effects }) {
    for (const made of effects.map(arrived)) {
      if (by !== game.localId) play(game, made);
      if (made.noise !== undefined)
        emitNoise(game, { at: made.at, radius: made.noise, source: by });
    }
  },
});

/** The events every action shares, by key. */
export const actionEvents = { effects: effected };

/** Runs `apply` as `run` on `game`, and returns the effects it left for the host to send. */
function within(
  game: Session,
  run: Omit<Run, "effects">,
  apply: () => void,
): Effect[] {
  const effects: Effect[] = [];
  runs.set(game, { ...run, effects });
  try {
    apply();
  } finally {
    runs.delete(game);
  }
  return effects;
}

/**
 * A player action. `name` is what its requests travel under within the content entry that lists
 * it in its `actions`, and what its cooldown is timed under.
 */
export function defineAction<I>(name: string, spec: ActionSpec<I>): Action<I> {
  /** What the action's cooldown is timed under in `game`. */
  const timer = (game: Session): string => {
    const address = game.eventAddresses.get(request);
    if (address === undefined)
      throw new Error(`Action not registered: ${name}`);
    return `${address.content}.${address.event}`;
  };

  /** Whether the host takes `input` from `actor`; one it takes starts its cooldown. */
  const accepts = (game: Session, actor: Player, input: I): boolean => {
    const { stamina, cooldown } = spec;
    if (stamina !== undefined && !hostSpends(game, actor.id, stamina))
      return false;
    const stood = spec.stood?.(actor, input);
    if (
      stood !== undefined &&
      !couldStand(game, actor.id, stood.at, stood.leeway ?? 0)
    )
      return false;
    if (spec.check !== undefined && !spec.check(game, actor, input))
      return false;
    return (
      cooldown === undefined || hostReady(game, actor.id, timer(game), cooldown)
    );
  };

  const request = contentEvent({
    schema: z.object({
      action: z.number().int().positive(),
      input: spec.input,
    }),
    to: "host",
    receive(game, { action, input }, by) {
      confirmAction(game, by, action);
      const actor = game.players.get(by);
      if (actor === undefined || !accepts(game, actor, input)) return;
      const effects = within(game, { mode: "host", action }, () => {
        spec.apply(game, actor, input);
      });
      if (effects.length > 0)
        effected.send(game, { by, effects: effects.map(sent) });
    },
  });

  const action: Action<I> = {
    name,
    perform(game, input) {
      const { local } = game;
      const key = timer(game);
      if (game.time < (game.localReadyAt.get(key) ?? -Infinity)) return false;
      if (spec.stamina !== undefined) {
        const left = spendStamina(local.stamina, spec.stamina);
        if (left === null) return false;
        local.stamina = left;
      }
      if (spec.cooldown !== undefined)
        game.localReadyAt.set(key, game.time + spec.cooldown);
      // The actor's state goes with the request, so the host checks it against a fresh report.
      game.reportNow = true;
      const number = nextAction(game);
      within(game, { mode: "predict", action: number }, () => {
        spec.apply(game, local, input);
      });
      request.send(game, { action: number, input });
      return true;
    },
  };
  requests.set(action, request);
  return action;
}

/** Registers each of `actions` under the content entry `name`. */
export function registerActions(
  game: Session,
  name: string,
  actions: readonly Action<never>[],
): void {
  for (const action of actions) {
    const request = requests.get(action);
    if (request === undefined) throw new Error(`Not an action: ${action.name}`);
    if (game.events.get(name)?.has(action.name) === true)
      throw new Error(`Event already registered: ${name}.${action.name}`);
    registerEvents(game, name, { [action.name]: request });
  }
}

/**
 * What an action may change on this client now:
 * - world: anything, as the host does
 * - predicted: world entities, each held as predicted, as the actor's client does
 * - none: nothing, as the host does as it acts itself, before it applies its action for real
 */
function scope(game: Session): "world" | "predicted" | "none" {
  const run = runs.get(game);
  if (run === undefined || run.mode === "host")
    return game.hosting ? "world" : "none";
  return game.hosting ? "none" : "predicted";
}

/** Whether the action being applied may change `entity` here; holds it if it is predicted. */
function mayChange(game: Session, entity: WorldEntity): boolean {
  const run = runs.get(game);
  switch (scope(game)) {
    case "world":
      return true;
    case "predicted":
      if (run !== undefined) hold(game, run.action, entity);
      return true;
    case "none":
      return false;
  }
}

/** Whichever of the session's players and world entities `body` is; null for neither. */
function which(
  game: Session,
  body: Player | WorldEntity,
): { player: Player } | { entity: WorldEntity } | null {
  const player = game.players.get(body.id);
  if (player === body) return { player };
  const entity = game.entities.get(body.id);
  if (entity === body) return { entity };
  return null;
}

/**
 * Deals `amount` damage to `body`. A player's health is the host's to change, so only the host
 * hurts players; a world entity is hurt on the actor's client too, as predicted.
 */
export function hurt(
  game: Session,
  body: Player | WorldEntity,
  amount: number,
): void {
  const found = which(game, body);
  if (found === null) return;
  if ("player" in found) {
    if (scope(game) === "world") hurtPlayer(game, found.player, amount);
  } else if (mayChange(game, found.entity)) applyDamage(found.entity, amount);
}

/**
 * Pushes `body` `distance` pixels straight away from `from`. A player is pushed by the host, as a
 * move it forces on the player, stopping at walls and bodies; a world entity is pushed on the
 * actor's client too, as predicted, and does as `blocked` says when a wall is in its way.
 */
export function push(
  game: Session,
  body: Player | WorldEntity,
  from: Point,
  distance: number,
  blocked: Blocked = "stop",
): void {
  const found = which(game, body);
  if (found === null) return;
  if ("player" in found) {
    if (scope(game) === "world")
      hurtPlayer(game, found.player, 0, { from, distance });
  } else if (mayChange(game, found.entity))
    knockBack(found.entity, from, distance, game.world.map, blocked);
}

/** A dash an actor makes as it acts. Distances in pixels, times in sim seconds. */
export interface ActorDash {
  /** Which way, in radians. */
  readonly aim: number;
  readonly distance: number;
  readonly seconds: number;
}

/**
 * The actor's own dash as it acts: its own client dashes it at once, stopping at walls and short
 * of bodies, and the host lets the actor's reports carry it up to `distance` past its own speed
 * while the dash lasts.
 */
export function dash(game: Session, actor: Player, made: ActorDash): void {
  const run = runs.get(game);
  if (run?.mode === "predict" && actor === game.local)
    startDash(
      actor,
      made.aim,
      made.distance,
      made.seconds,
      game.world.map,
      solidBodiesBut(game, actor),
    );
  if (run?.mode === "host")
    allowMove(game, actor.id, made.distance, made.seconds);
}

/**
 * Shows and sounds `made`: on the actor's client as it acts, and on every other client once the
 * host applies the action, which makes its noise, once, on every client. Only for an action
 * being applied.
 */
export function effect(game: Session, made: Effect): void {
  const run = runs.get(game);
  if (run === undefined) throw new Error("An effect outside an action");
  if (run.mode === "predict") play(game, made);
  else run.effects.push(made);
}
