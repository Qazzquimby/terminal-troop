import { z } from "zod";
import { solidBodiesBut } from "./collision.js";
import { contentEvent, registerEvents } from "./content-event.js";
import type { ContentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { removeEntity, spawnEntity } from "./entities.js";
import { applyDamage } from "./entity.js";
import { showFlash } from "./flashes.js";
import { hurtPlayer } from "./health.js";
import {
  carriedIn,
  giveItem,
  predictInventory,
  resendItems,
  setUsesLeft,
  takeItem,
} from "./inventories.js";
import { addItem, carried, ItemId, removeItem, usesLeft } from "./inventory.js";
import type { CarriedItem, Inventory } from "./inventory.js";
import { knockBack } from "./knockback.js";
import type { Blocked } from "./knockback.js";
import type { Point } from "./map.js";
import { emitNoise, kindTags } from "./noise.js";
import type { Player } from "./player.js";
import { dashEnd, startDash } from "./player.js";
import { confirmAction, hold, nextAction } from "./prediction.js";
import type { Session } from "./session.js";
import { declaredSound, soundNoise } from "./sound.js";
import type { Sound } from "./sound.js";
import { spendStamina } from "./stamina.js";
import { actorTime, alter, queueAction } from "./steering.js";
import type { WorldData } from "./world-data.js";

/**
 * What a player can do, as plain sim code. Times in sim seconds.
 *
 * The actor's client applies it at once, as a prediction, and sends its input to the host,
 * stamped with the step it acted in. The host applies it in that step of its own run of the
 * actor, so where the actor stood is where the host has it, if the actor has the stamina, is off
 * cooldown and passes `check`. Either way the host confirms it, and what the actor's client
 * predicted gives way to the host's state: what the host did, or nothing if it refused. The host
 * acting itself applies it at once, for real.
 */
export interface ActionSpec<I> {
  /** What the actor means to do, as its client sends it: checked, encoded and decoded back. */
  readonly input: z.ZodType<I>;
  /** Least time between two of one actor's, or what a session's config makes it; none when left out. */
  readonly cooldown?: number | ((game: Session) => number);
  /** Stamina each costs the actor; an actor with less does not act. None when left out. */
  readonly stamina?: number;
  /** Whether the host takes the input, past the declared checks; true when left out. */
  check?(game: Session, actor: Player, input: I): boolean;
  /**
   * What the action does, run on the actor's client as it acts and on the host once it accepts:
   * reads the world, where the actor stands included, and changes it through `hurt`, `push`,
   * `dash` and `effect`, the actor's items through `give` and `take`, and what only the host
   * changes through `spawn`, `removeFromWorld` and `changeWorld`.
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

/**
 * A flash where an effect lands: how wide, and whether it connected; with a tracer streaking to
 * it from `from`, for a shot.
 */
interface Flash {
  readonly radius: number;
  readonly hit: boolean;
  readonly from?: Point | undefined;
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
  /**
   * Played there for every client's listener, as far as its range carries; one with a range also
   * makes a noise out to it, unless `noise` says otherwise.
   */
  readonly sound?: Sound;
  readonly flash?: Flash;
  /** Shown on the actor, as its item draws a use. */
  readonly use?: Use;
  /**
   * How far, in pixels, the noise it makes carries; as far as its sound's range when left out,
   * and none for a sound without one.
   */
  readonly noise?: number;
  /**
   * Tags its noise carries past its maker's kind, saying how it was made. Other clients get them
   * as the host sends them, the maker's kind first.
   */
  readonly tags?: readonly string[];
}

/** How far the noise `made` makes carries, in pixels; undefined for none. */
const noiseOf = (made: Effect): number | undefined =>
  made.noise ?? (made.sound === undefined ? undefined : soundNoise(made.sound));

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
    void game.sfx.play(sound.url, at, game.local, {
      ...(sound.volume !== undefined && { volume: sound.volume }),
      ...(sound.range !== undefined && { range: sound.range }),
    });
  if (flash !== undefined) showFlash(game, { at, ...flash });
  const actor = game.players.get(by);
  if (use !== undefined && actor !== undefined)
    actor.use = { ...use, center: { x: at.x, y: at.y }, startedAt: game.time };
}

/**
 * An effect as it travels: its sound by url, and its noise as the host worked it out, with every
 * tag it carries.
 */
const SentEffect = z.object({
  x: z.number(),
  y: z.number(),
  sound: z.string().max(512).optional(),
  flash: z
    .object({
      radius: z.number().min(0),
      hit: z.boolean(),
      from: z.object({ x: z.number(), y: z.number() }).optional(),
    })
    .optional(),
  use: z.object({ item: ItemId, hit: z.boolean() }).optional(),
  noise: z.number().min(0).optional(),
  tags: z.array(z.string().min(1).max(32)).max(8).optional(),
});
type SentEffect = z.infer<typeof SentEffect>;

/** `made` as the host sends it on behalf of `by`, its noise tagged with `by`'s kind first. */
function sent(game: Session, by: string, made: Effect): SentEffect {
  const { at, sound, flash, use } = made;
  const noise = noiseOf(made);
  const tags =
    noise === undefined ? [] : [...kindTags(game, by), ...(made.tags ?? [])];
  return {
    x: at.x,
    y: at.y,
    ...(sound !== undefined && { sound: sound.url }),
    ...(flash !== undefined && { flash }),
    ...(use !== undefined && { use }),
    ...(noise !== undefined && { noise }),
    ...(tags.length > 0 && { tags }),
  };
}

/**
 * `effect` as it arrived; a sound no content declared plays nothing. Its noise and tags are as
 * the host sent them, the noise of its sound included.
 */
function arrived({ x, y, sound, flash, use, noise, tags }: SentEffect): {
  readonly made: Effect;
  readonly noise?: { readonly radius: number; readonly tags: string[] };
} {
  const declared = sound === undefined ? undefined : declaredSound(sound);
  return {
    made: {
      at: { x, y },
      ...(declared !== undefined && { sound: declared }),
      ...(flash !== undefined && { flash }),
      ...(use !== undefined && { use }),
    },
    ...(noise !== undefined && { noise: { radius: noise, tags: tags ?? [] } }),
  };
}

/**
 * Effects the host made, sent to every client, the host's own included: each plays them and makes
 * their noise, but the actor's own client plays an action's effects only as it acts.
 */
const effected = contentEvent({
  schema: z.object({
    by: z.string().min(1).max(64),
    effects: z.array(SentEffect).max(32),
    /** Set for an action's effects, which the actor's own client played as it acted. */
    acted: z.literal(true).optional(),
  }),
  to: "all",
  from: "host",
  receive(game, { by, effects, acted }) {
    for (const { made, noise } of effects.map(arrived)) {
      if (acted !== true || by !== game.localId) play(game, by, made);
      if (noise !== undefined)
        emitNoise(game, { at: made.at, source: by, ...noise });
    }
  },
});

/** The events every action shares, by key. */
export const actionEvents = { effects: effected };

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

/** Seconds two clocks counting the same steps may drift apart by in their sums. */
const DRIFT = 1e-6;

/**
 * Whether the host takes an action by `actor`, timed under `key`, as off cooldown on the
 * actor's own clock. A taken action starts `cooldown` seconds of it.
 */
function hostReady(
  game: Session,
  actor: Player,
  key: string,
  cooldown: number,
): boolean {
  const now = actorTime(game, actor);
  const timers = game.readyAt.get(key) ?? new Map<string, number>();
  const readyAt = timers.get(actor.id) ?? -Infinity;
  if (now < readyAt - DRIFT) return false;
  timers.set(actor.id, now + cooldown);
  game.readyAt.set(key, timers);
  return true;
}

/** Takes `amount` stamina from `actor`, as part of the step it acts in. */
function spend(game: Session, actor: Player, amount: number): void {
  alter(game, actor, (player) => {
    player.stamina = spendStamina(player.stamina, amount) ?? player.stamina;
  });
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

  /**
   * Whether the host takes `input` from `actor`, a remote player; one it takes costs its stamina
   * and starts its cooldown.
   */
  const accepts = (game: Session, actor: Player, input: I): boolean => {
    const { stamina } = spec;
    const cooldown = cooldownIn(game);
    if (stamina !== undefined && actor.stamina.value < stamina) return false;
    if (spec.check !== undefined && !spec.check(game, actor, input))
      return false;
    if (
      cooldown !== undefined &&
      !hostReady(game, actor, timer(game), cooldown)
    )
      return false;
    if (stamina !== undefined) spend(game, actor, stamina);
    return true;
  };

  /**
   * As the host, applies `input` by `actor` for real, and sends its effects to every client; the
   * host's own player plays them here at once.
   */
  const applyAsHost = (
    game: Session,
    actor: Player,
    input: I,
    action: number,
  ): void => {
    const { effects } = within(game, { mode: "host", action }, () => {
      spec.apply(game, actor, input);
    });
    if (actor === game.local)
      for (const made of effects) play(game, actor.id, made);
    if (effects.length > 0)
      effected.send(game, {
        by: actor.id,
        effects: effects.map((made) => sent(game, actor.id, made)),
        acted: true,
      });
  };

  const request = contentEvent({
    schema: z.object({
      action: z.number().int().positive(),
      /** The step of the actor's own the action was made in. */
      step: z.number().int().nonnegative(),
      input: spec.input,
      /** Set when the actor's client predicted a change to its items. */
      items: z.literal(true).optional(),
    }),
    to: "host",
    receive(game, { action, step, input, items }, by) {
      queueAction(game, by, step, () => {
        confirmAction(game, by, action);
        // The actor's items go out again with the confirmation, so its client settles on them
        // even if it missed an earlier change to them.
        if (items === true) resendItems(game, by);
        const actor = game.players.get(by);
        if (actor === undefined || !accepts(game, actor, input)) return;
        applyAsHost(game, actor, input, action);
      });
    },
  });

  const action: Action<I> = {
    name,
    perform(game, input) {
      const { local } = game;
      const key = timer(game);
      const { stamina } = spec;
      if (game.time < (game.localReadyAt.get(key) ?? -Infinity)) return false;
      if (stamina !== undefined && local.stamina.value < stamina) return false;
      if (
        game.hosting &&
        spec.check !== undefined &&
        !spec.check(game, local, input)
      )
        return false;
      const cooldown = cooldownIn(game);
      if (cooldown !== undefined)
        game.localReadyAt.set(key, game.time + cooldown);
      if (stamina !== undefined) spend(game, local, stamina);
      const number = nextAction(game);
      if (game.hosting) {
        applyAsHost(game, local, input, number);
        return true;
      }
      const { items } = within(
        game,
        { mode: "predict", action: number },
        () => {
          spec.apply(game, local, input);
        },
      );
      request.send(game, {
        action: number,
        step: game.step,
        input,
        ...(items && { items: true as const }),
      });
      game.pilot.steered = true;
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
 * - none: nothing, as any other client does outside an action
 */
function scope(game: Session): "world" | "predicted" | "none" {
  const run = runs.get(game);
  if (run?.mode === "predict") return "predicted";
  return game.hosting ? "world" : "none";
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
 * As the host, knocks `player` `distance` pixels straight away from `from`, as far as walls and
 * other bodies let it go from where it stands, sliding there over the configured knockback time.
 * A push from where the player stands has no way to go, and is dropped.
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
  const seconds = game.config.player.knockbackSeconds;
  const dash = {
    vx: (to.x - player.x) / seconds,
    vy: (to.y - player.y) / seconds,
    seconds,
    to: { x: to.x, y: to.y },
  };
  alter(game, player, (knocked) => {
    knocked.dash = dash;
  });
}

/**
 * Pushes `body` `distance` pixels straight away from `from`. A player is pushed by the host,
 * which runs every player, stopping at walls and bodies; a world entity is pushed on the actor's
 * client too, as predicted, and does as `blocked` says when a wall is in its way.
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
 * The actor's own dash as it acts, stopping at walls and short of bodies: its own client dashes
 * it at once, and the host as it applies the action. Returns where the dash stops if nothing
 * moves meanwhile; one under a knockback goes on with that, and returns its end. Outside an
 * action, nobody dashes, and it returns where the actor stands.
 */
export function dash(game: Session, actor: Player, made: ActorDash): Point {
  let end: Point = { x: actor.x, y: actor.y };
  if (!runs.has(game)) return end;
  alter(game, actor, (player) => {
    end = startDash(
      player,
      made.aim,
      made.distance,
      made.seconds,
      game.world.map,
      solidBodiesBut(game, player),
    );
  });
  return end;
}

/**
 * Shows and sounds `made`, and makes its noise, once, on every client:
 * - in an action, the actor makes it: its own client plays it as it acts, and every other client
 *   once the host applies the action
 * - outside one, `by`, the player or entity whose doing it is, makes it, and only the host's
 *   does: an entity's update, say. Every client, the host's own included, plays it once it
 *   arrives from the host; an effect made on any other client is dropped.
 */
export function effect(
  game: Session,
  made: Effect,
  by?: { readonly id: string },
): void {
  const run = runs.get(game);
  if (run === undefined) {
    if (by === undefined)
      throw new Error("An effect outside an action names whose it is");
    if (game.hosting)
      effected.send(game, { by: by.id, effects: [sent(game, by.id, made)] });
  } else if (run.mode === "predict") play(game, game.localId, made);
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
function itemAt(
  game: Session,
  actor: Player,
  slot: number,
): CarriedItem | null {
  if (predicting(game) !== null && actor === game.local)
    return actor.inventory[slot] ?? null;
  return carriedIn(game, actor.id, slot);
}

/**
 * The uses left on the item in `actor`'s `slot`, as the action being applied sees it; null for
 * none, or an item whose uses are unlimited.
 */
export function usesAt(
  game: Session,
  actor: Player,
  slot: number,
): number | null {
  const held = itemAt(game, actor, slot);
  return held === null ? null : usesLeft(held);
}

/**
 * Puts `item` in `actor`'s first empty slot, with `left` uses left, or all its uses when left
 * out: on the actor's own client at once, as predicted, and in the host's record once the host
 * applies the action. Returns whether it went in.
 */
export function give(
  game: Session,
  actor: Player,
  item: string,
  left?: number,
): boolean {
  const run = predicting(game);
  if (run === null) return giveItem(game, actor.id, item, undefined, left);
  const definition = game.itemDefinitions.get(item);
  if (definition === undefined || actor !== game.local) return false;
  let fit = false;
  predictItems(game, run, (inventory) => {
    fit = addItem(inventory, carried(definition, left));
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
  const held = itemAt(game, actor, slot)?.id ?? null;
  if (held === null || (item !== undefined && held !== item)) return null;
  const run = predicting(game);
  if (run === null) return takeItem(game, actor.id, slot, held) ? held : null;
  predictItems(game, run, (inventory) => removeItem(inventory, slot));
  return held;
}

/**
 * Spends `amount` of the uses left on the item in `actor`'s `slot`: on the actor's own client at
 * once, as predicted, and in the host's record once the host applies the action. An item that
 * spends its last use is gone, with its breaking sound. Does nothing to an empty slot or an item
 * whose uses are unlimited. Returns the uses left; null when it spent none.
 */
export function spendUses(
  game: Session,
  actor: Player,
  slot: number,
  amount = 1,
): number | null {
  const held = itemAt(game, actor, slot);
  const before = held === null ? null : usesLeft(held);
  if (held === null || before === null) return null;
  const left = Math.max(0, before - amount);
  const run = predicting(game);
  if (run !== null)
    predictItems(game, run, (inventory) => {
      inventory[slot] = left === 0 ? null : carried(held, left);
    });
  else if (!setUsesLeft(game, actor.id, slot, held.id, left)) return null;
  if (left === 0 && held.breaks !== undefined)
    effect(game, { at: { x: actor.x, y: actor.y }, sound: held.breaks }, actor);
  return left;
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
