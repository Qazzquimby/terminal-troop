import { sumBy } from "lodash-es";
import { z } from "zod";
import { arrivalPoint } from "./arrival.js";
import { separateBody, solidBodiesBut } from "./collision.js";
import { contentEvent } from "./content-event.js";
import { drive, RideWire } from "./driving.js";
import type { Ride } from "./driving.js";
import { isGhost } from "./ghosts.js";
import { heldSlot, weightOf } from "./inventories.js";
import { cycleSlot, selectSlot } from "./inventory.js";
import {
  follow,
  lerpAngle,
  renderPosition,
  snapPrevious,
} from "./interpolation.js";
import { isAreaFree } from "./map.js";
import type { Point } from "./map.js";
import { applyContentState, contentState } from "./player-data.js";
import type { Controls, Dash, Player } from "./player.js";
import {
  aimAt,
  createPlayer,
  smoothPlayer,
  stepDash,
  updatePlayer,
} from "./player.js";
import type { Session } from "./session.js";
import type { Stamina } from "./stamina.js";
import { isStunned } from "./status.js";

/*
 * Players move as the host runs them. Each client runs the same movement code for its own player
 * at once, and sends the host what it steers with whenever that changes, stamped with the step it
 * starts on; its actions go the same way. The host runs each player's steps as they arrive, going
 * back over the steps a late one changes, and sends where every player is with its snapshots,
 * with the last step of the player's it ran. A client whose own player the host put elsewhere than
 * it did takes the host's word and runs its later steps again on top.
 */

/** Steps a client keeps of its own player, waiting for the host to run them: 3s at 60Hz. */
const PILOT_STEPS = 180;
/** Steps the host keeps of each player, to go back over for one that arrives late: 0.5s at 60Hz. */
const FEED_STEPS = 30;
/**
 * Steps the host runs a player behind the first of its steps to arrive, so that later ones that
 * take longer on the way still arrive before the host runs them: 0.1s at 60Hz.
 */
const LEAD_STEPS = 6;
/** Steps the host runs at once to catch up with a player whose steps arrive far ahead. */
const CATCH_UP_STEPS = 120;
/** How far apart two runs of a step may end and still count as the same. */
const SAME = 1e-3;
/** Seconds over which the local player is drawn easing out of a correction, as a time constant. */
const EASE_SECONDS = 0.08;
/** Pixels past which a correction is drawn at once rather than eased: a jump, not a nudge. */
const EASE_UP_TO = 120;

/** What a player steers with, held from step to step until it changes. */
interface Steer {
  /** The way it heads: each axis -1..1. */
  readonly move: Point;
  readonly sprint: boolean;
  /** The slot it holds; null for none. */
  readonly held: number | null;
}

const IDLE: Steer = { move: { x: 0, y: 0 }, sprint: false, held: null };

const Slot = z.number().int().min(0).max(63).nullable();

const SteerWire = z.object({
  move: z.object({
    x: z.number().min(-1).max(1),
    y: z.number().min(-1).max(1),
  }),
  sprint: z.boolean(),
  held: Slot,
});

/** What one step runs on: the steer held, and whether crouch was pressed in it. */
interface StepInput {
  readonly steer: Steer;
  readonly crouch: boolean;
  /**
   * Whether the player was stunned in the step, as the client that first ran it found it: it then
   * stands still whatever it steers with. A step run again keeps it, so a stun that starts later
   * does not reach back.
   */
  readonly stunned?: boolean;
}

/** Everything a step of a player's movement reads and changes. */
interface Motion {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly stamina: Stamina;
  readonly crouched: boolean;
  readonly dash: Dash | null;
  readonly ride: Ride | null;
}

const Spot = z.object({ x: z.number(), y: z.number() });

const MotionWire = z.object({
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  stamina: z.object({
    value: z.number(),
    exhausted: z.boolean(),
    rested: z.number(),
  }),
  crouched: z.boolean(),
  dash: z
    .object({
      vx: z.number(),
      vy: z.number(),
      seconds: z.number(),
      to: Spot.optional(),
    })
    .nullable(),
  ride: RideWire.default(null),
});

/**
 * A player as the host sends it with its snapshots: where it is and how it moves, what it steers
 * with, the state its simulation sets, and the last of its own steps the host has run; null for
 * the host's own player, or one that has not steered yet.
 */
export const PlayerEntry = MotionWire.extend({
  id: z.string().min(1).max(64),
  name: z.string().max(64),
  step: z.number().int().nullable(),
  steer: SteerWire,
  content: z.record(z.string(), z.unknown()),
});
export type PlayerEntry = z.infer<typeof PlayerEntry>;

/**
 * What a player reports of itself, which its simulation does not set: its name, facing and
 * reported state, and where it starts, until a host has placed it.
 */
export const PlayerReport = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  aim: z.number(),
  content: z.record(z.string(), z.unknown()),
  at: Spot.optional(),
});
export type PlayerReport = z.infer<typeof PlayerReport>;

/** A change made to a player in a step besides its walking: a dash, a knockback, a cost. */
type Change = (player: Player) => void;

/** One step a client ran of a player it runs, kept to run again. */
interface Mark {
  readonly step: number;
  readonly dt: number;
  readonly input: StepInput;
  /** The steer that arrived for this step, if one did. */
  readonly arrived: Steer | null;
  readonly changes: Change[];
  /** Where the step left the player. */
  motion: Motion;
}

/** The local player's own steps, while another client hosts. */
export interface Pilot {
  /** The steps the host has not answered yet, oldest first. */
  marks: Mark[];
  /** The steer the latest step ran on. */
  steer: Steer;
  /** The steer as last sent to the current host; null to send the next whatever it is. */
  sent: Steer | null;
  /** Whether the current host has heard a steer from it, so its answers count its steps. */
  steered: boolean;
  /** Whether a host has placed the player: until then it reports where it starts. */
  placed: boolean;
  /** The next step steers nothing, as the page hides. */
  halted: boolean;
  /**
   * The step it told the current host, newly hosting, to go on from: the host's word on earlier
   * steps is passed over. Null when it told none.
   */
  resumed: number | null;
  /**
   * How far from where it is the local player is drawn, easing to nothing: where the host's
   * corrections moved it from, so a correction shows as a quick slide rather than a jump.
   */
  shown: Point;
}

/** An item a player sent the host, waiting for the host's run of the player to reach its step. */
interface Queued {
  readonly step: number;
  readonly steer?: Steer;
  readonly crouch?: boolean;
  readonly act?: () => void;
}

/** While hosting, how the host runs one remote player from what it sends. */
export interface Feed {
  /** The last of the player's own steps the host has run; null before it has steered. */
  label: number | null;
  /** The steer the host runs the player on. */
  steer: Steer;
  /** Sim seconds on the player's own clock, which its cooldowns keep to. */
  time: number;
  /**
   * Host steps to wait before running the player's next step: as many as its latest late
   * arrival was late by, so the ones after it arrive in time.
   */
  wait: number;
  readonly queue: Queued[];
  /** The steps last run, oldest first, to go back over. */
  marks: Mark[];
  /**
   * The step the player's own client had reached when it told this host, newly hosting, where it
   * was: what arrives for that step or earlier only says what it steers with after. Null before.
   */
  resumed: number | null;
}

/** How often, and how far, the host has put the local player elsewhere than it predicted. */
export interface Corrections {
  count: number;
  /** Pixels, summed over every correction. */
  total: number;
  largest: number;
}

export function createPilot(): Pilot {
  return {
    marks: [],
    steer: IDLE,
    sent: null,
    steered: false,
    placed: false,
    halted: false,
    resumed: null,
    shown: { x: 0, y: 0 },
  };
}

const motionOf = (player: Player): Motion => ({
  x: player.x,
  y: player.y,
  vx: player.vx,
  vy: player.vy,
  stamina: player.stamina,
  crouched: player.crouched,
  dash: player.dash,
  ride: player.ride,
});

function place(player: Player, motion: Motion): void {
  player.x = motion.x;
  player.y = motion.y;
  player.vx = motion.vx;
  player.vy = motion.vy;
  player.stamina = { ...motion.stamina };
  player.crouched = motion.crouched;
  player.dash = motion.dash === null ? null : { ...motion.dash };
  player.ride = motion.ride === null ? null : { ...motion.ride };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= SAME;

/** Whether two rides are of the same vehicle, pointing and going alike; or both none. */
function sameRide(a: Ride | null, b: Ride | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.vehicle === b.vehicle &&
    a.driving === b.driving &&
    near(a.heading, b.heading) &&
    near(a.speed, b.speed) &&
    near(a.turn, b.turn)
  );
}

/**
 * Whether two runs of a step left the player alike. Two that left it inside one vehicle, off the
 * wheel, are alike wherever: it sits where the vehicle is, which each client has from the host.
 */
function sameMotion(a: Motion, b: Motion): boolean {
  if (
    a.ride !== null &&
    b.ride !== null &&
    !a.ride.driving &&
    !b.ride.driving &&
    a.ride.vehicle === b.ride.vehicle
  )
    return true;
  if (
    !near(a.x, b.x) ||
    !near(a.y, b.y) ||
    !near(a.vx, b.vx) ||
    !near(a.vy, b.vy) ||
    !near(a.stamina.value, b.stamina.value) ||
    a.stamina.exhausted !== b.stamina.exhausted ||
    a.crouched !== b.crouched ||
    !sameRide(a.ride, b.ride)
  )
    return false;
  if (a.dash === null || b.dash === null) return a.dash === b.dash;
  return (
    near(a.dash.vx, b.dash.vx) &&
    near(a.dash.vy, b.dash.vy) &&
    near(a.dash.seconds, b.dash.seconds)
  );
}

const sameSteer = (a: Steer, b: Steer): boolean =>
  a.move.x === b.move.x &&
  a.move.y === b.move.y &&
  a.sprint === b.sprint &&
  a.held === b.held;

/**
 * One step of `player`'s movement: it walks as `input` steers it, slowed by what it carries,
 * goes on with any dash, then steps out of every body it overlaps; or, at the wheel, drives. The
 * same on every client that runs the player. `live` is false while running a step again. A
 * ghost's body is not moved: where it watches from is its own client's. A stunned player steers
 * nothing, as if it let go of every control, but goes on with any dash or knockback.
 */
function movePlayer(
  game: Session,
  player: Player,
  input: StepInput,
  dt: number,
  live = true,
): void {
  if (isGhost(player)) {
    player.vx = 0;
    player.vy = 0;
    player.dash = null;
    return;
  }
  const { steer, crouch } =
    input.stunned === true
      ? { steer: { ...IDLE, held: input.steer.held }, crouch: false }
      : input;
  if (player.ride !== null) {
    drive(game, player, steer.move, dt, live, game.config);
    return;
  }
  const { map } = game.world;
  updatePlayer(
    player,
    { move: steer.move, sprint: steer.sprint, crouch },
    dt,
    map,
    game.config,
    weightOf(game, player),
  );
  const others = solidBodiesBut(game, player);
  stepDash(player, dt, map, others);
  separateBody(player, others, map);
}

/** A steer sent to the host: the step it starts on, and whether crouch was pressed in that step. */
const steered = contentEvent({
  schema: SteerWire.extend({
    step: z.number().int().nonnegative(),
    crouch: z.literal(true).optional(),
  }),
  to: "host",
  receive(game, { step, crouch, ...steer }, by) {
    enqueue(game, by, {
      step,
      steer,
      ...(crouch === true && { crouch: true }),
    });
  },
});

/**
 * Where a player's own client has it, sent to a new host as it takes over: the step it had run to,
 * where that step left it, and what it steered with. The old host's last word on the player is
 * older, and the steps in between went to the old host, so the new host goes on from here.
 */
const resumed = contentEvent({
  schema: MotionWire.extend({
    step: z.number().int().nonnegative(),
    steer: SteerWire,
  }),
  to: "host",
  receive(game, { step, steer, ...motion }, by) {
    resume(game, by, step, steer, motion);
  },
});

/** The events steering travels as, by key. */
export const steeringEvents = { steer: steered, resume: resumed };

/** The latest step this client kept of `player`, if it runs the player's steps and keeps them. */
function latestMark(game: Session, player: Player): Mark | undefined {
  if (player === game.local)
    return game.hosting ? undefined : game.pilot.marks.at(-1);
  return game.hosting ? game.feeds.get(player.id)?.marks.at(-1) : undefined;
}

/**
 * Changes `player` by `change` now, as part of the step it is in: if this client runs the player's
 * steps, it makes the change again whenever it runs that step again.
 */
export function alter(game: Session, player: Player, change: Change): void {
  change(player);
  const mark = latestMark(game, player);
  if (mark === undefined) return;
  mark.changes.push(change);
  mark.motion = motionOf(player);
}

/**
 * Puts `player` at `at` at once, standing still, as part of the step it is in: a client that runs
 * its steps makes the move again as it runs that step again, and it is drawn there rather than
 * sliding from where it was.
 */
export function placePlayer(game: Session, player: Player, at: Point): void {
  alter(game, player, (placed) => {
    placed.x = at.x;
    placed.y = at.y;
    placed.vx = 0;
    placed.vy = 0;
    placed.dash = null;
  });
  snapPrevious(player);
  player.tx = player.x;
  player.ty = player.y;
}

/**
 * Sim seconds on `actor`'s own clock: the step the host has run it to, for a remote player while
 * hosting; this client's time otherwise.
 */
export function actorTime(game: Session, actor: Player): number {
  if (!game.hosting || actor === game.local) return game.time;
  return game.feeds.get(actor.id)?.time ?? game.time;
}

function feedOf(game: Session, id: string): Feed {
  const known = game.feeds.get(id);
  if (known !== undefined) return known;
  const feed: Feed = {
    label: null,
    steer: IDLE,
    time: game.time,
    wait: 0,
    queue: [],
    marks: [],
    resumed: null,
  };
  game.feeds.set(id, feed);
  return feed;
}

/** Queues `item` from player `id` for its step; runs an action at once for a player not run here. */
function enqueue(game: Session, id: string, item: Queued): void {
  const player = game.players.get(id);
  if (!game.hosting || player === undefined || player === game.local) {
    item.act?.();
    return;
  }
  const feed = feedOf(game, id);
  feed.label ??= item.step - 1 - LEAD_STEPS;
  const at = feed.queue.findIndex((queued) => queued.step > item.step);
  if (at === -1) feed.queue.push(item);
  else feed.queue.splice(at, 0, item);
}

/**
 * As the host, runs `act` for player `by` once its run of the player reaches `step`: where the
 * player stood in that step, as its own client ran it.
 */
export function queueAction(
  game: Session,
  by: string,
  step: number,
  act: () => void,
): void {
  enqueue(game, by, { step, act });
}

/**
 * Runs the next step of `player`, `feed.label`, on what arrived for it: the steers that start on
 * it, then its movement, then the actions in it. `redo` is a run of the step this replaces, whose
 * steer and changes it makes again.
 */
function runStep(
  game: Session,
  player: Player,
  feed: Feed,
  dt: number,
  redo?: Mark,
): void {
  const step = feed.label ?? 0;
  let arrived = redo?.arrived ?? null;
  let crouch = redo?.input.crouch ?? false;
  const acts: (() => void)[] = [];
  while (feed.queue[0] !== undefined && feed.queue[0].step <= step) {
    const item = feed.queue.shift();
    if (item?.steer !== undefined) {
      arrived = item.steer;
      crouch ||= item.crouch === true;
    }
    if (item?.act !== undefined) acts.push(item.act);
  }
  if (arrived !== null) feed.steer = arrived;
  feed.time += dt;
  player.held = feed.steer.held;
  heldSlot.set(player, player.held);
  const input = {
    steer: feed.steer,
    crouch,
    stunned: redo?.input.stunned ?? isStunned(game, player.id),
  };
  movePlayer(game, player, input, dt, redo === undefined);
  feed.marks.push({
    step,
    dt,
    input,
    arrived,
    changes: [],
    motion: motionOf(player),
  });
  if (feed.marks.length > FEED_STEPS) feed.marks.shift();
  for (const change of redo?.changes ?? []) alter(game, player, change);
  for (const act of acts) act();
}

/**
 * Goes back to just before `from` and runs `player`'s steps from there again, up to the one it had
 * reached, taking in what arrived late for them, then waits as many steps as it went back, so the
 * next arrivals that take as long come in time. Too far back to go, it picks up from `from` where
 * the player now is, and waits for nothing.
 */
function rewind(game: Session, player: Player, feed: Feed, from: number): void {
  const until = feed.label ?? from - 1;
  const at = feed.marks.findIndex((mark) => mark.step === from - 1);
  const base = feed.marks[at];
  if (base === undefined) {
    feed.label = from - 1;
    feed.marks = [];
    return;
  }
  feed.wait = Math.min(feed.wait + until - from + 1, FEED_STEPS);
  const undone = new Map(
    feed.marks.splice(at + 1).map((mark) => [mark.step, mark]),
  );
  place(player, base.motion);
  feed.steer = base.input.steer;
  feed.time -= sumBy([...undone.values()], (mark) => mark.dt);
  feed.label = from - 1;
  while (feed.label < until) {
    feed.label++;
    const redo = undone.get(feed.label);
    runStep(game, player, feed, redo?.dt ?? 0, redo);
  }
}

/**
 * Takes in what arrived for `feed`'s steps up to `step` without running them: the latest steer
 * sent for them is the one the player goes on with.
 */
function takeUpTo(feed: Feed, step: number): void {
  while (feed.queue[0] !== undefined && feed.queue[0].step <= step) {
    const item = feed.queue.shift();
    if (item?.steer !== undefined) feed.steer = item.steer;
    item?.act?.();
  }
}

/**
 * As the host, puts player `id` where its own client says it was after its step `step`, and runs
 * it on from there on `steer`.
 */
function resume(
  game: Session,
  id: string,
  step: number,
  steer: Steer,
  motion: Motion,
): void {
  const player = game.players.get(id);
  if (!game.hosting || player === undefined || player === game.local) return;
  const feed = feedOf(game, id);
  place(player, motion);
  snapPrevious(player);
  player.held = steer.held;
  feed.label = step;
  feed.resumed = step;
  feed.steer = steer;
  feed.wait = 0;
  feed.marks = [
    {
      step,
      dt: 0,
      input: { steer, crouch: false },
      arrived: null,
      changes: [],
      motion: motionOf(player),
    },
  ];
}

/**
 * As the host, runs one step of every remote player: from what it last sent, going back over the
 * steps a late arrival changes, and catching up with steps sent far ahead. A player that has not
 * steered stands, but goes on with any knockback.
 */
function stepFeeds(game: Session, dt: number): void {
  const amount = 1 - Math.exp(-game.config.net.smoothing * dt);
  for (const player of game.players.values()) {
    if (player === game.local) continue;
    player.aim = lerpAngle(player.aim, player.taim, amount);
    const feed = feedOf(game, player.id);
    if (feed.label === null) {
      movePlayer(
        game,
        player,
        {
          steer: feed.steer,
          crouch: false,
          stunned: isStunned(game, player.id),
        },
        dt,
      );
      continue;
    }
    if (feed.resumed !== null) takeUpTo(feed, feed.resumed);
    const first = feed.queue[0]?.step;
    if (first !== undefined && first <= feed.label)
      rewind(game, player, feed, first);
    else if (first !== undefined && first > feed.label + FEED_STEPS) {
      const target = first - 1;
      for (let run = 0; feed.label < target && run < CATCH_UP_STEPS; run++) {
        feed.label++;
        runStep(game, player, feed, dt);
      }
      feed.label = Math.max(feed.label, target);
    }
    if (feed.wait > 0) feed.wait--;
    else {
      feed.label++;
      runStep(game, player, feed, dt);
    }
  }
  // The host runs every player, so where it has each is where it is.
  for (const player of game.players.values()) {
    player.tx = player.x;
    player.ty = player.y;
  }
}

/** The click of the local player switching what it holds, heard by it alone. */
const switchUrl = new URL("./sfx/slot-switch.mp3", import.meta.url).href;

/** Plays the local player's slot-switch click. */
function hearSwitch(game: Session): void {
  void game.sfx.play(switchUrl, null, null, {
    volume: game.config.player.switchVolume,
  });
}

/**
 * Runs the local player's step on `controls`: it selects, faces and moves. While another client
 * hosts, the step is kept, and a change of steer goes to the host stamped with it.
 */
export function steerLocal(
  game: Session,
  controls: Controls,
  dt: number,
): void {
  const { local, pilot } = game;
  const before = local.held;
  if (controls.select !== null)
    local.held = selectSlot(local.inventory, controls.select);
  local.held = cycleSlot(local.inventory, local.held, controls.cycle);
  if (local.held !== before) hearSwitch(game);
  local.aim = aimAt(local, controls.aim);
  const stunned = isStunned(game, local.id);
  const input: StepInput = pilot.halted
    ? { steer: { ...IDLE, held: local.held }, crouch: false, stunned }
    : {
        steer: {
          move: { x: controls.move.x, y: controls.move.y },
          sprint: controls.sprint,
          held: local.held,
        },
        crouch: controls.crouch,
        stunned,
      };
  pilot.halted = false;
  pilot.steer = input.steer;
  const ease = Math.exp(-dt / EASE_SECONDS);
  pilot.shown = { x: pilot.shown.x * ease, y: pilot.shown.y * ease };
  movePlayer(game, local, input, dt);
  heldSlot.set(local, local.held);
  if (game.hosting) return;
  pilot.marks.push({
    step: game.step,
    dt,
    input,
    arrived: null,
    changes: [],
    motion: motionOf(local),
  });
  if (pilot.marks.length > PILOT_STEPS) pilot.marks.shift();
  if (
    pilot.sent !== null &&
    sameSteer(pilot.sent, input.steer) &&
    !input.crouch
  )
    return;
  steered.send(game, {
    step: game.step,
    ...input.steer,
    ...(input.crouch && { crouch: true as const }),
  });
  pilot.sent = input.steer;
  pilot.steered = true;
}

/**
 * Moves every remote player one step, once this step's events are in: while hosting, each as it
 * steers; otherwise, each eases towards where the host last put it.
 */
export function moveRemotePlayers(game: Session, dt: number): void {
  if (game.hosting) {
    stepFeeds(game, dt);
    return;
  }
  for (const player of game.players.values())
    if (player !== game.local)
      smoothPlayer(player, dt, game.config.net.smoothing);
}

/**
 * Stops the local player where it is, as its page hides and its steps stop: the host stops it in
 * the step after the latest it ran.
 */
export function haltSteering(game: Session): void {
  if (game.hosting) return;
  const { pilot } = game;
  const steer = { ...IDLE, held: game.local.held };
  pilot.halted = true;
  steered.send(game, { step: game.step + 1, ...steer });
  pilot.sent = steer;
  pilot.steered = true;
}

/** Every player as the host sends it, the host's own included. */
export function playerEntries(game: Session): PlayerEntry[] {
  return [...game.players.values()].map((player) => {
    const feed = player === game.local ? undefined : game.feeds.get(player.id);
    return {
      id: player.id,
      name: player.name,
      step: feed?.label ?? null,
      ...motionOf(player),
      steer: feed?.steer ?? (player === game.local ? game.pilot.steer : IDLE),
      content: contentState(game, player, true),
    };
  });
}

/** What the local player reports of itself. */
export function playerReport(game: Session): PlayerReport {
  const { local, pilot } = game;
  return {
    id: local.id,
    name: local.name,
    aim: local.aim,
    content: contentState(game, local, false),
    ...(!pilot.placed && !game.hosting && { at: { x: local.x, y: local.y } }),
  };
}

/** Takes the host's entry for a player this client follows: it moves steadily there. */
function followEntry(game: Session, player: Player, entry: PlayerEntry): void {
  player.name = entry.name;
  follow(player, entry, game.config.net);
  player.stamina = { ...entry.stamina };
  player.crouched = entry.crouched;
  player.ride = entry.ride;
  player.held = entry.steer.held;
  applyContentState(game, player, entry.content, true);
}

/** Takes the host's entry for the local player: where the host ran it to, and the steps since. */
function reconcile(game: Session, entry: PlayerEntry): void {
  const { local, pilot } = game;
  pilot.placed = true;
  // A ghost watches from where its own client puts it; the host's word on it counts again once
  // it is revived, as the next entry after reviving puts it by the cruiser.
  if (game.hosting || isGhost(local)) return;
  const { step } = entry;
  if (step === null) {
    // The host has heard no steer from this client yet: until then it owns where the player is.
    if (!pilot.steered) place(local, entry);
    return;
  }
  if (step > game.step || step < (pilot.resumed ?? step)) return;
  const mark = pilot.marks.find((kept) => kept.step === step);
  const later = pilot.marks.filter((kept) => kept.step > step);
  pilot.marks = later;
  if (mark !== undefined && sameMotion(mark.motion, entry)) return;
  const before = { x: local.x, y: local.y };
  place(local, entry);
  for (const kept of later) {
    movePlayer(game, local, kept.input, kept.dt, false);
    for (const change of kept.changes) change(local);
    kept.motion = motionOf(local);
  }
  const moved = Math.hypot(local.x - before.x, local.y - before.y);
  if (moved <= SAME) return;
  const shown = {
    x: pilot.shown.x + before.x - local.x,
    y: pilot.shown.y + before.y - local.y,
  };
  pilot.shown =
    Math.hypot(shown.x, shown.y) > EASE_UP_TO ? { x: 0, y: 0 } : shown;
  const { corrections } = game;
  corrections.count++;
  corrections.total += moved;
  corrections.largest = Math.max(corrections.largest, moved);
}

/** A player new to this client, where `at` puts it. */
function addPlayer(
  game: Session,
  id: string,
  name: string,
  at: Point,
  aim: number,
): Player {
  const player = createPlayer(id, name, at, game.config);
  player.aim = aim;
  player.taim = aim;
  snapPrevious(player);
  game.players.set(id, player);
  return player;
}

/**
 * Takes the players a host's snapshot carries: the local player as `reconcile` does, every other
 * eased towards its entry. One this client lacks is added if `known` says it is in the room.
 * Returns the ids of the players added.
 */
export function applyPlayerEntries(
  game: Session,
  entries: readonly PlayerEntry[],
  known: (id: string) => boolean,
): string[] {
  const added: string[] = [];
  for (const entry of entries) {
    game.heard.set(entry.id, entry);
    if (entry.id === game.localId) {
      reconcile(game, entry);
      continue;
    }
    let player = game.players.get(entry.id);
    if (player === undefined) {
      if (!known(entry.id)) continue;
      player = addPlayer(game, entry.id, entry.name, entry, 0);
      added.push(entry.id);
    }
    followEntry(game, player, entry);
  }
  return added;
}

/**
 * Takes what a remote player reports of itself: its name, facing and reported state. A player
 * new to this client is added where the host last put it, or where it says it starts; failing
 * both, the host places it by the rally point, and any other client waits for the host's word.
 * "rejected" for the local player's own id, or a player not yet placed.
 */
export function hearPlayer(
  game: Session,
  report: PlayerReport,
): "added" | "updated" | "rejected" {
  if (report.id === game.localId) return "rejected";
  let player = game.players.get(report.id);
  const added = player === undefined;
  if (player === undefined) {
    const heard = game.heard.get(report.id);
    const { radius } = game.config.player;
    const at =
      heard ??
      (report.at !== undefined &&
      isAreaFree(game.world.map, report.at.x, report.at.y, radius)
        ? report.at
        : game.hosting
          ? arrivalPoint(
              game.world,
              game.rally,
              radius,
              game.config.arrival.spread,
              Math.random,
            )
          : undefined);
    if (at === undefined) return "rejected";
    player = addPlayer(game, report.id, report.name, at, report.aim);
    if (heard !== undefined) followEntry(game, player, heard);
  }
  player.name = report.name;
  player.taim = report.aim;
  applyContentState(game, player, report.content, false);
  return added ? "added" : "updated";
}

/**
 * As a client that has just taken over hosting, runs every remote player on from the host's last
 * snapshot of it: where it was, how it steered, and the last of its steps run.
 */
export function takeOverPlayers(game: Session): void {
  game.feeds.clear();
  game.pilot.marks = [];
  game.pilot.placed = true;
  for (const player of game.players.values()) {
    if (player === game.local) continue;
    const entry = game.heard.get(player.id);
    const feed = feedOf(game, player.id);
    if (entry === undefined) continue;
    place(player, entry);
    snapPrevious(player);
    player.tx = player.x;
    player.ty = player.y;
    feed.label = entry.step;
    feed.steer = entry.steer;
    player.held = entry.steer.held;
  }
}

/**
 * As a client that has stopped hosting, or whose host changed: it tells the new host where its
 * latest step left its player, for the new host to go on from rather than from the old host's
 * older word on it, and its steps go on with the new host from there.
 */
export function followNewHost(game: Session): void {
  game.feeds.clear();
  const { pilot } = game;
  pilot.sent = null;
  pilot.steered = false;
  pilot.resumed = null;
  // Its steer goes again with its next step all the same, so a host that missed this catches up.
  const mark = pilot.marks.at(-1);
  if (mark !== undefined) {
    resumed.send(game, {
      step: mark.step,
      steer: mark.input.steer,
      ...mark.motion,
    });
    pilot.resumed = mark.step;
  }
  for (const player of game.players.values()) {
    player.tx = player.x;
    player.ty = player.y;
  }
}

/** Where the local player is drawn, `alpha` of the way into the next step. */
export function drawnLocal(game: Session, alpha: number): Point {
  const at = renderPosition(game.local, alpha);
  const { shown } = game.pilot;
  return { x: at.x + shown.x, y: at.y + shown.y };
}

/** Forgets what this client ran or heard of player `id`, as it leaves. */
export function forgetPlayer(game: Session, id: string): void {
  game.feeds.delete(id);
  game.heard.delete(id);
}
