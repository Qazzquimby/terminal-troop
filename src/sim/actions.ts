import { z } from "zod";
import { canStandAt } from "./arrival.js";
import { nearestFreePoint, solidBodiesBut } from "./collision.js";
import { contentEvent, registerEvents } from "./content-event.js";
import type { ContentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { removeEntity, spawnEntity } from "./entities.js";
import { applyDamage } from "./entity.js";
import { showFlash } from "./flashes.js";
import {
  expectedEpoch,
  ForcedMove,
  forcedMoves,
  takeForcedMove,
} from "./forced-move.js";
import { hurtPlayer } from "./health.js";
import {
  giveItem,
  itemIn,
  predictInventory,
  resendItems,
  takeItem,
} from "./inventories.js";
import { addItem, ItemId, removeItem } from "./inventory.js";
import type { Inventory } from "./inventory.js";
import { knockBack } from "./knockback.js";
import type { Blocked } from "./knockback.js";
import type { Point } from "./map.js";
import { allowMove, couldStand, rebaseMoves } from "./move-checks.js";
import { emitNoise } from "./noise.js";
import type { Player } from "./player.js";
import { dashEnd, startDash } from "./player.js";
import { confirmAction, hold, nextAction } from "./prediction.js";
import type { Session } from "./session.js";
import { declaredSound } from "./sound.js";
import type { Sound } from "./sound.js";
import { spendStamina } from "./stamina.js";
import { hostSpends } from "./stamina-checks.js";
import type { WorldData } from "./world-data.js";

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
  /** Least time between two of one actor's, or what a session's config makes it; none when left out. */
  readonly cooldown?: number | ((game: Session) => number);
  /** Stamina each costs the actor; an actor with less does not act. None when left out. */
  readonly stamina?: number;
  /** Where the actor says it stood, which the host holds to its checks on the actor's moves. */
  stood?(actor: Player, input: I): Stood;
  /** Whether the host takes the input, past the declared checks; true when left out. */
  check?(game: Session, actor: Player, input: I): boolean;
  /**
   * What the action does, run on the actor's client as it acts and on the host once it accepts:
   * reads the world, and changes it through `hurt`, `push`, `dash` and `effect`, the actor's items
   * through `give` and `take`, and what only the host changes through `spawn`, `removeFromWorld`
   * and `changeWorld`.
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

/** An item use an effect shows its actor making, landing where the effect is. */
interface Use {
  readonly item: string;
  /** Whether it connected with anything. */
  readonly hit: boolean;
}

/** What an action shows and sounds, at one spot. */
export interface Effect {
  readonly at: Point;
  /** Played there for every client's listener. */
  readonly sound?: Sound;
  readonly flash?: Flash;
  /** Shown on the actor, as its item draws a use. */
  readonly use?: Use;
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
  /** Whether it predicted a change to the actor's items, which the host then sends again. */
  items: boolean;
}

/** The action being applied on each session, if any. */
const runs = new WeakMap<Session, Run>();

/** Each action's requests. */
const requests = new WeakMap<Action<never>, ContentEvent<unknown>>();

/** Plays `made`'s sound and shows its flash on this client, and its use on player `by`. */
function play(
  game: Session,
  by: string,
  { at, sound, flash, use }: Effect,
): void {
  if (sound !== undefined)
    void game.sfx.play(
      sound.url,
      at,
      game.local,
      sound.volume === undefined ? {} : { volume: sound.volume },
    );
  if (flash !== undefined) showFlash(game, { at, ...flash });
  const actor = game.players.get(by);
  if (use !== undefined && actor !== undefined)
    actor.use = { ...use, center: { x: at.x, y: at.y }, startedAt: game.time };
}

/** An effect as it travels: its sound by url. */
const SentEffect = z.object({
  x: z.number(),
  y: z.number(),
  sound: z.string().max(512).optional(),
  flash: z.object({ radius: z.number().min(0), hit: z.boolean() }).optional(),
  use: z.object({ item: ItemId, hit: z.boolean() }).optional(),
  noise: z.number().min(0).optional(),
});
type SentEffect = z.infer<typeof SentEffect>;

const sent = ({ at, sound, flash, use, noise }: Effect): SentEffect => ({
  x: at.x,
  y: at.y,
  ...(sound !== undefined && { sound: sound.url }),
  ...(flash !== undefined && { flash }),
  ...(use !== undefined && { use }),
  ...(noise !== undefined && { noise }),
});

/** `effect` as it arrived; a sound no content declared plays nothing. */
function arrived({ x, y, sound, flash, use, noise }: SentEffect): Effect {
  const declared = sound === undefined ? undefined : declaredSound(sound);
  return {
    at: { x, y },
    ...(declared !== undefined && { sound: declared }),
    ...(flash !== undefined && { flash }),
    ...(use !== undefined && { use }),
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
      if (by !== game.localId) play(game, by, made);
      if (made.noise !== undefined)
        emitNoise(game, { at: made.at, radius: made.noise, source: by });
    }
  },
});

/** The events every action shares, by key. */
export const actionEvents = { effects: effected };

/** A move the host forces on one player, for every client to take. */
const forced = contentEvent({
  schema: ForcedMove.extend({ target: z.string() }),
  to: "all",
  from: "host",
  receive(game, { target, ...move }) {
    takeForcedMove(game, target, move);
  },
});

/** The events forced moves travel as, by key. */
export const forcedMoveEvents = { forced };

/**
 * As the host, moves `player` to `to` under a new epoch, as a slide over `slide.seconds` or at
 * once, on every client: the local player here at once, and every other client's copy of the
 * player as the move reaches it. The player's own client reports the new epoch once it takes
 * the move, and until it does every client holds its reported position back, so its copies stay
 * where the host put it. Does nothing on a client not hosting, or for a player not in the session.
 */
function forcePlayer(
  game: Session,
  player: Player,
  to: Point,
  slide?: ForcedMove["slide"],
): void {
  if (!game.hosting || game.players.get(player.id) !== player) return;
  const epoch = Math.max(expectedEpoch(game, player.id), player.heardEpoch) + 1;
  const move: ForcedMove = {
    epoch,
    to: { x: to.x, y: to.y },
    ...(slide !== undefined && { slide }),
  };
  takeForcedMove(game, player.id, move);
  if (player !== game.local) rebaseMoves(game, player.id, move.to);
  forcedMoves.set(game, { ...forcedMoves.get(game), [player.id]: move });
  forced.send(game, { target: player.id, ...move });
}

/**
 * As the host, moves `player` to `at` at once, or to the nearest point a player can stand when
 * `at` is blocked. An `at` that is not a finite point is ignored.
 */
export function correctPlayer(game: Session, player: Player, at: Point): void {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
  const { radius } = game.config.player;
  const to = canStandAt(game.world, at, radius)
    ? at
    : nearestFreePoint(game.world.map, radius, at);
  forcePlayer(game, player, to);
}

/**
 * As the host, knocks `player` `distance` pixels straight away from `from`, as far as walls and
 * other bodies let it go from where the host sees it, sliding there over the configured knockback
 * time on every client. A push from where the player stands has no way to go, and is dropped.
 */
function knockPlayer(
  game: Session,
  player: Player,
  from: Point,
  distance: number,
): void {
  const dx = player.x - from.x;
  const dy = player.y - from.y;
  if (distance <= 0 || (dx === 0 && dy === 0)) return;
  const to = dashEnd(
    player,
    Math.atan2(dy, dx),
    distance,
    game.world.map,
    solidBodiesBut(game, player),
  );
  forcePlayer(game, player, to, {
    seconds: game.config.player.knockbackSeconds,
  });
}

/**
 * Runs `apply` as `run` on `game`, and returns what it left: the effects for the host to send,
 * and whether it predicted a change to the actor's items.
 */
function within(
  game: Session,
  run: Pick<Run, "mode" | "action">,
  apply: () => void,
): Pick<Run, "effects" | "items"> {
  const ran: Run = { ...run, effects: [], items: false };
  runs.set(game, ran);
  try {
    apply();
  } finally {
    runs.delete(game);
  }
  return ran;
}

/**
 * Whether the host takes an action by player `by`, timed under `key`, as off cooldown. A taken
 * action starts `cooldown` seconds of it.
 */
function hostReady(
  game: Session,
  by: string,
  key: string,
  cooldown: number,
): boolean {
  const { seconds } = game.config.net.useSlack;
  const timers = game.readyAt.get(key) ?? new Map<string, number>();
  const readyAt = timers.get(by) ?? -Infinity;
  if (game.time < readyAt - seconds) return false;
  timers.set(by, game.time + cooldown);
  game.readyAt.set(key, timers);
  return true;
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

  /** The action's cooldown in `game`, if it has one. */
  const cooldownIn = (game: Session): number | undefined =>
    typeof spec.cooldown === "function" ? spec.cooldown(game) : spec.cooldown;

  /** Whether the host takes `input` from `actor`; one it takes starts its cooldown. */
  const accepts = (game: Session, actor: Player, input: I): boolean => {
    const { stamina } = spec;
    const cooldown = cooldownIn(game);
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
      /** Set when the actor's client predicted a change to its items. */
      items: z.literal(true).optional(),
    }),
    to: "host",
    receive(game, { action, input, items }, by) {
      confirmAction(game, by, action);
      // The actor's items go out again with the confirmation, so its client settles on them even
      // if it missed an earlier change to them.
      if (items === true) resendItems(game, by);
      const actor = game.players.get(by);
      if (actor === undefined || !accepts(game, actor, input)) return;
      const { effects } = within(game, { mode: "host", action }, () => {
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
      const cooldown = cooldownIn(game);
      if (cooldown !== undefined)
        game.localReadyAt.set(key, game.time + cooldown);
      // The actor's state goes with the request, so the host checks it against a fresh report.
      game.reportNow = true;
      const number = nextAction(game);
      const { items } = within(
        game,
        { mode: "predict", action: number },
        () => {
          spec.apply(game, local, input);
        },
      );
      request.send(game, {
        action: number,
        input,
        ...(items && { items: true as const }),
      });
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
      knockPlayer(game, found.player, from, distance);
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
  if (run.mode === "predict") play(game, game.localId, made);
  else run.effects.push(made);
}

/** The run predicting the action on the actor's own client, if that is how it is being applied. */
function predicting(game: Session): Run | null {
  const run = runs.get(game);
  return run?.mode === "predict" ? run : null;
}

/**
 * Changes the local player's items as `run` predicts, held until the host has handled the action:
 * they then take the host's record, which rolls back what the host refused. `reaching` is a lying
 * item the action takes out of the world, which this client does not reach for again meanwhile.
 */
function predictItems(
  game: Session,
  run: Run,
  change: (inventory: Inventory) => void,
  reaching?: string,
): void {
  run.items = true;
  predictInventory(game, run.action, change, reaching);
}

/**
 * The item in `actor`'s `slot` as the action being applied sees it: as the actor's own client
 * predicts its items while it acts, as the host keeps them otherwise. Null for none.
 */
function itemAt(game: Session, actor: Player, slot: number): string | null {
  if (predicting(game) !== null && actor === game.local)
    return actor.inventory[slot]?.id ?? null;
  return itemIn(game, actor.id, slot);
}

/**
 * Puts `item` in `actor`'s first empty slot: on the actor's own client at once, as predicted, and
 * in the host's record once the host applies the action. Returns whether it went in.
 */
export function give(game: Session, actor: Player, item: string): boolean {
  const run = predicting(game);
  if (run === null) return giveItem(game, actor.id, item);
  const definition = game.itemDefinitions.get(item);
  if (definition === undefined || actor !== game.local) return false;
  let fit = false;
  predictItems(game, run, (inventory) => {
    fit = addItem(inventory, definition);
  });
  return fit;
}

/**
 * Takes the item out of `actor`'s `slot`, if it is `item`, or whatever it is when left out: on
 * the actor's own client at once, as predicted, and out of the host's record once the host
 * applies the action. Returns the item taken; null for none.
 */
export function take(
  game: Session,
  actor: Player,
  slot: number,
  item?: string,
): string | null {
  const held = itemAt(game, actor, slot);
  if (held === null || (item !== undefined && held !== item)) return null;
  const run = predicting(game);
  if (run === null) return takeItem(game, actor.id, slot, held) ? held : null;
  predictItems(game, run, (inventory) => removeItem(inventory, slot));
  return held;
}

/**
 * Takes `entity` out of the world, which only the host does; its snapshots carry that to every
 * client. The actor's own client leaves it lying until then, but does not reach for it again.
 */
export function removeFromWorld(game: Session, entity: WorldEntity): void {
  const run = predicting(game);
  if (run !== null) predictItems(game, run, () => undefined, entity.id);
  else if (scope(game) === "world") removeEntity(game, entity.id);
}

/**
 * Spawns an entity of the kind `kind` at `at`, which only the host does; its snapshots carry it
 * to every client.
 */
export function spawn(
  game: Session,
  kind: string,
  at: Point,
  data: unknown,
): void {
  if (scope(game) === "world") spawnEntity(game, kind, at.x, at.y, data);
}

/** Changes the world state `data` by `change`, which only the host does. */
export function changeWorld<S>(
  game: Session,
  data: WorldData<S>,
  change: (value: S) => S,
): void {
  if (scope(game) === "world") data.set(game, change(data.get(game)));
}
