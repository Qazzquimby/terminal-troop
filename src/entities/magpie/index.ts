import { z } from "zod";
import { drawEmoji, drawHeldItem } from "../../render/index.js";
import {
  ambientLightAt,
  canSeeFrom,
  defineEntity,
  directionalVision,
  effect,
  emittedLights,
  hurtSinceLastStep,
  INERT_TAG,
  isAreaFree,
  isLit,
  itemInstances,
  livingBody,
  livingPlayers,
  removeFromWorld,
  rounded,
  sound,
  spawnWorldItem,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  HurtRecord,
  ItemInstance,
  Player,
  Point,
  Scatter,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import {
  between,
  nearest,
  preyNear,
  Route,
  strikeEach,
  strikeIf,
  Time,
  walk,
  Waypoint,
} from "../hunt.js";
import { drawRing } from "../bodies.js";
import { avoidingLight, planRoute } from "../route.js";
import type { Avoid } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const chitterUrl = new URL("./sfx/chitter.mp3", import.meta.url).href;
const alarmUrl = new URL("./sfx/alarm.mp3", import.meta.url).href;
const pickUpUrl = new URL("./sfx/pick-up.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/**
 * How magpie beetles nest, forage for scrap and defend their hoard. Distances in pixels, times in
 * sim seconds.
 */
export interface MagpieConfig {
  readonly spawn: Scatter;
  /** How groups keep arriving; each group shares one nest. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its speed foraging and guarding, in pixels a second. */
  readonly wanderSpeed: number;
  /** Its speed chasing a player, in pixels a second. */
  readonly chaseSpeed: number;
  /** How far it sees players and scrap within its cone or surroundings. */
  readonly sightRange: number;
  /** The points it searches round its nest: how many, how far out, and spots tried for them. */
  readonly search: {
    readonly count: number;
    readonly range: number;
    readonly tries: number;
  };
  /** How near its nest counts as at it: where it guards, and where a group shares one nest. */
  readonly nestRadius: number;
  /** How far from the nest's middle it lays the scrap it brings. */
  readonly dropRadius: number;
  /** How near a player it sees, away from its nest, must be to spook it. */
  readonly spookRange: number;
  readonly spookSeconds: number;
  readonly guardSeconds: number;
  /** How far a thief must get from the scrap it stole for the nest's revenge to end. */
  readonly revengeRange: number;
  /** Damage it deals its quarry when in reach, at most once a cooldown. */
  readonly damage: number;
  readonly attackRange: number;
  readonly attackCooldown: number;
  /** Seconds between plans of a chase. */
  readonly repathInterval: number;
  /** Seconds between chitters while foraging or guarding, drawn between the two. */
  readonly chitterGap: { readonly min: number; readonly max: number };
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly chitter: number;
    readonly alarm: number;
    readonly pickUp: number;
    readonly attack: number;
  };
}

const NAME = "magpie";

const GLYPH = "🪲";

/** What it hoards. */
const SCRAP = "scrap";

/** The key on a lying item's own state naming the nest that claimed it. */
const CLAIM = "nest";

/** Most search points one keeps; each is a bit of `seen`. */
const MAX_POINTS = 24;

const COLOURS = {
  wander: "#6f9b8c",
  guard: "#d8a13a",
  spook: "#e0702a",
  revenge: "#d8473a",
} as const;

/**
 * Everyone reads its mode, to colour it, its facing, and what it carries, to draw it held; the
 * rest only the host reads.
 * - wander: visits its search points one by one, fetching any scrap it sees back to its nest
 * - guard: patrols round its nest until `until`
 * - spook: chases `quarry` until `until`
 * - revenge: hunts `quarry`, who took scrap from its nest, light or no light
 * `nest` is where its group settled, null until it first steps, and `nestId` the number its claims
 * carry. `seen` holds a bit for each of `points` visited; `goal` is the one it heads for.
 * `fetching` is the lying scrap it heads for, `carrying` the item it carries.
 */
export const MagpieState = z.object({
  mode: z.enum(["wander", "guard", "spook", "revenge"]),
  until: Time,
  nest: Waypoint.nullable(),
  nestId: z.number().int(),
  points: z.array(Waypoint).max(MAX_POINTS),
  seen: z.number().int(),
  goal: z.number().int().nullable(),
  fetching: z.string().nullable(),
  carrying: z.string().nullable(),
  quarry: z.string().nullable(),
  route: Route,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  chitterAt: Time,
  facing: rounded(2),
});

export type MagpieState = z.output<typeof MagpieState>;

type Mode = MagpieState["mode"];

/** A fresh magpie beetle's state at world time `now`, yet to settle a nest. */
export function freshMagpie(now: number): MagpieState {
  return {
    mode: "wander",
    until: now,
    nest: null,
    nestId: 0,
    points: [],
    seen: 0,
    goal: null,
    fetching: null,
    carrying: null,
    quarry: null,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
    chitterAt: now,
    facing: 0,
  };
}

/** Its nest, which it settles before it first steps. */
function nestOf(state: MagpieState): Point {
  return state.nest ?? { x: 0, y: 0 };
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A point drawn evenly from the disc of `range` round `at`. */
function pointNear(at: Point, range: number): Point {
  const angle = Math.random() * Math.PI * 2;
  const reach = range * Math.sqrt(Math.random());
  return {
    x: at.x + Math.cos(angle) * reach,
    y: at.y + Math.sin(angle) * reach,
  };
}

/** Free, dark spots within the search range of `nest` for it to visit, as many as it finds. */
function searchPoints(
  game: Session,
  nest: Point,
  config: MagpieConfig,
): Point[] {
  const { world } = game;
  const points: Point[] = [];
  const { count, range, tries } = config.search;
  for (let i = 0; i < tries && points.length < count; i++) {
    const at = pointNear(nest, range);
    if (!isAreaFree(world.map, at.x, at.y, config.radius)) continue;
    if (ambientLightAt(world, at) !== null) continue;
    points.push(at);
  }
  return points.slice(0, MAX_POINTS);
}

/**
 * Settles its nest where it stands, or, when another of its kind already settled one near, joins
 * that one: so a group that arrives together shares one nest. Then lays its search points.
 */
function settle(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
): MagpieState {
  const kind = game.kindIds.get(NAME);
  let nest: Point = { x: self.x, y: self.y };
  let nestId = 1 + Math.floor(Math.random() * (2 ** 31 - 2));
  for (const other of game.entities.values()) {
    if (other.kind !== kind || other.id === self.id) continue;
    const parsed = MagpieState.safeParse(other.data);
    const theirs = parsed.success ? parsed.data.nest : null;
    if (theirs === null || !parsed.success) continue;
    if (distance(theirs, self) > config.nestRadius) continue;
    nest = theirs;
    nestId = parsed.data.nestId;
    break;
  }
  return {
    ...state,
    nest,
    nestId,
    points: searchPoints(game, nest, config),
  };
}

/** Whether `instance` is claimed by the nest `nestId`. */
const claimedBy = (instance: ItemInstance, nestId: number) =>
  instance.state?.[CLAIM] === nestId;

/** Every item claimed by the nest `nestId`, wherever it is. */
const hoard = (game: Session, nestId: number) =>
  itemInstances(game).filter((instance) => claimedBy(instance, nestId));

/** A living player carrying an item claimed by the nest `nestId`; null for none. */
function thief(game: Session, nestId: number): Player | null {
  for (const instance of hoard(game, nestId)) {
    const { place } = instance;
    if (!("carrier" in place)) continue;
    if (livingPlayers(game).includes(place.carrier)) return place.carrier;
  }
  return null;
}

/** Whether its revenge on `quarry` holds: alive, and still near some of what it stole. */
function revengeHolds(
  game: Session,
  state: MagpieState,
  config: MagpieConfig,
): boolean {
  const quarry = livingBody(game, state.quarry);
  if (quarry === null) return false;
  return hoard(game, state.nestId).some(
    (instance) => distance(instance.at, quarry) < config.revengeRange,
  );
}

/** Whether it sees `at`, within its cone or surroundings. */
function seer(
  game: Session,
  self: WorldEntity,
  state: MagpieState,
  config: MagpieConfig,
): (at: Point) => boolean {
  const sources = directionalVision(
    self,
    state.facing,
    game.config.vision,
    config.sightRange,
  );
  return (at) =>
    sources.some((source) => canSeeFrom(game.world.map, source, at));
}

/** `state` in `mode` until `until`, after `quarry`, its route planned anew at once. */
function enter(
  state: MagpieState,
  mode: Mode,
  until: number,
  now: number,
  quarry: string | null = null,
): MagpieState {
  return {
    ...state,
    mode,
    until,
    quarry,
    goal: null,
    fetching: null,
    route: [],
    repathAt: now,
  };
}

/**
 * The scrap lying about that it sees and may fetch, nearest first: not its own nest's, and not
 * in light, which it keeps out of.
 */
function scrapInSight(
  game: Session,
  self: WorldEntity,
  state: MagpieState,
  sees: (at: Point) => boolean,
): WorldEntity | null {
  const lying = itemInstances(game, SCRAP).flatMap((instance) =>
    "lying" in instance.place &&
    !claimedBy(instance, state.nestId) &&
    sees(instance.at)
      ? [instance.place.lying]
      : [],
  );
  if (lying.length === 0) return null;
  const lights = emittedLights(game);
  return nearest(
    self,
    lying.filter((entity) => !isLit(game, entity, lights)),
  );
}

/**
 * The mode it moves to. A thief of its nest's scrap draws its revenge, which holds until the
 * thief dies or gets far from what it stole. `hurt` since its last step, it is spooked by
 * whatever body hurt it, or by the nearest player when it was no one's doing. A spook or guard
 * runs out back to foraging. Foraging or guarding, a player it sees near its nest sets it
 * guarding; foraging away from its nest, a player it sees close by spooks it.
 */
function think(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
  hurt: HurtRecord | null,
): MagpieState {
  const now = game.worldTime;
  if (state.mode === "revenge")
    return revengeHolds(game, state, config)
      ? state
      : enter(state, "wander", now, now);
  const taker = thief(game, state.nestId);
  if (taker !== null) return enter(state, "revenge", now, now, taker.id);
  if (hurt !== null) {
    const attacker = hurt.by === self.id ? null : livingBody(game, hurt.by);
    const quarry = attacker ?? nearest(self, livingPlayers(game));
    return enter(state, "spook", now + config.spookSeconds, now, quarry?.id);
  }
  const over = state.mode !== "wander" && now >= state.until;
  if (
    over ||
    (state.mode === "spook" && livingBody(game, state.quarry) === null)
  )
    return enter(state, "wander", now, now);
  if (state.mode === "spook") return state;
  const nest = nestOf(state);
  const sees = seer(game, self, state, config);
  const seen = livingPlayers(game).filter((player) => sees(player));
  if (seen.some((player) => distance(player, nest) <= config.nestRadius)) {
    const until = now + config.guardSeconds;
    return state.mode === "guard"
      ? { ...state, until }
      : enter(state, "guard", until, now);
  }
  const close = seen.find(
    (player) => distance(player, self) <= config.spookRange,
  );
  if (
    state.mode === "wander" &&
    close !== undefined &&
    distance(self, nest) > config.nestRadius
  )
    return enter(state, "spook", now + config.spookSeconds, now, close.id);
  if (state.mode !== "wander" || state.carrying !== null) return state;
  if (state.fetching !== null && game.entities.has(state.fetching))
    return state;
  const scrap = scrapInSight(game, self, state, sees);
  return {
    ...state,
    fetching: scrap?.id ?? null,
    route: scrap === null && state.fetching === null ? state.route : [],
  };
}

/** How it plans a route in `mode`: out of light, but for revenge, which pays it no mind. */
function routing(game: Session, mode: Mode): Avoid | undefined {
  return mode === "revenge" ? undefined : avoidingLight(game);
}

/** A route for it to `to`, or none when no way reaches it. */
function routeTo(
  game: Session,
  self: WorldEntity,
  state: MagpieState,
  to: Point,
): Point[] {
  return (
    planRoute(
      game.world.map,
      self.radius,
      self,
      to,
      routing(game, state.mode),
    ) ?? []
  );
}

/** The index of an unseen search point near it, drawn among the nearest few; null for none. */
function nextGoal(self: Point, state: MagpieState): number | null {
  const unseen = state.points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => (state.seen & (1 << index)) === 0)
    .sort((a, b) => distance(a.point, self) - distance(b.point, self))
    .slice(0, 3);
  return unseen[Math.floor(Math.random() * unseen.length)]?.index ?? null;
}

/** Visits its search points: at each it marks it seen, and heads for another unseen one near. */
function search(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
): MagpieState {
  if (state.route.length > 0) return state;
  const all = (1 << state.points.length) - 1;
  const marked =
    state.goal === null ? state.seen : state.seen | (1 << state.goal);
  // Every point seen, it starts its round afresh.
  const seen = marked === all ? 0 : marked;
  const goal = nextGoal(self, { ...state, seen });
  const point = goal === null ? undefined : state.points[goal];
  if (goal === null || point === undefined) return { ...state, seen, goal };
  const route = routeTo(game, self, state, point);
  // A point no route reaches is passed over, as seen.
  return route.length > 0
    ? { ...state, seen, goal, route }
    : { ...state, seen: seen | (1 << goal), goal: null };
}

/** A free spot within the drop radius of its nest, or the nest itself when none is found. */
function dropSpot(game: Session, nest: Point, config: MagpieConfig): Point {
  for (let attempt = 0; attempt < 8; attempt++) {
    const at = pointNear(nest, config.dropRadius);
    if (isAreaFree(game.world.map, at.x, at.y, game.config.worldItems.radius))
      return at;
  }
  return nest;
}

/** Lays `item` at `at`, claimed by the nest `nestId` when given, with its drop sound. */
function lay(
  game: Session,
  self: WorldEntity,
  item: string,
  at: Point,
  nestId?: number,
): void {
  spawnWorldItem(
    game,
    at,
    item,
    undefined,
    nestId === undefined ? undefined : { [CLAIM]: nestId },
  );
  const drop = game.itemDefinitions.get(item)?.drop;
  if (drop !== undefined) effect(game, { at, sound: drop }, self);
}

/**
 * Forages: carrying scrap, takes it home and lays it there, claimed, then guards; fetching scrap,
 * heads for it and picks it up; otherwise searches.
 */
function forage(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
  sounds: Sounds,
): MagpieState {
  const now = game.worldTime;
  const nest = nestOf(state);
  if (state.carrying !== null) {
    if (distance(self, nest) <= config.dropRadius + self.radius) {
      lay(
        game,
        self,
        state.carrying,
        dropSpot(game, nest, config),
        state.nestId,
      );
      return enter(
        { ...state, carrying: null },
        "guard",
        now + config.guardSeconds,
        now,
      );
    }
    if (state.route.length > 0) return state;
    return { ...state, route: routeTo(game, self, state, nest) };
  }
  const target =
    state.fetching === null ? undefined : game.entities.get(state.fetching);
  if (target === undefined)
    return search({ ...state, fetching: null }, self, game);
  if (distance(target, self) <= self.radius + target.radius + 2) {
    const instance = itemInstances(game, SCRAP).find(
      ({ place }) => "lying" in place && place.lying === target,
    );
    if (instance === undefined) return { ...state, fetching: null };
    removeFromWorld(game, target);
    effect(game, { at: { x: self.x, y: self.y }, sound: sounds.pickUp }, self);
    return {
      ...state,
      fetching: null,
      carrying: instance.item,
      goal: null,
      route: routeTo(game, self, { ...state, route: [] }, nest),
    };
  }
  if (state.route.length > 0) return state;
  const route = routeTo(game, self, state, target);
  return route.length > 0 ? { ...state, route } : { ...state, fetching: null };
}

/** Patrols round its nest: a new spot within the nest's radius each time it gets to one. */
function patrol(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
): MagpieState {
  if (state.route.length > 0) return state;
  const to = pointNear(nestOf(state), config.nestRadius);
  if (!isAreaFree(game.world.map, to.x, to.y, self.radius)) return state;
  return { ...state, route: routeTo(game, self, state, to) };
}

/** Chases its quarry, replanning when due. */
function chase(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
): MagpieState {
  const now = game.worldTime;
  const quarry = livingBody(game, state.quarry);
  if (quarry === null || now < state.repathAt) return state;
  return {
    ...state,
    route: routeTo(game, self, state, quarry),
    repathAt: now + config.repathInterval,
  };
}

/** Its quarry, when in reach of its bite. */
function inReach(
  game: Session,
  self: WorldEntity,
  state: MagpieState,
  config: MagpieConfig,
) {
  if (state.mode !== "spook" && state.mode !== "revenge") return [];
  return preyNear(
    game,
    self,
    (prey) => Math.max(config.attackRange, self.radius + prey.radius + 1),
    [INERT_TAG, NAME],
  ).filter((prey) => prey.id === state.quarry);
}

interface Sounds {
  readonly chitter: Sound;
  readonly alarm: Sound;
  readonly pickUp: Sound;
  readonly attack: Sound;
}

/**
 * Sounds, as the host, on every client, what a step from `previous` to `next` did: an alarm as a
 * chase begins, a bite, or a chitter when its time comes.
 */
function cue(
  self: WorldEntity,
  previous: MagpieState,
  next: MagpieState,
  game: Session,
  sounds: Sounds,
): void {
  const chasing = (mode: Mode) => mode === "spook" || mode === "revenge";
  const made = [
    !chasing(previous.mode) && chasing(next.mode) && sounds.alarm,
    next.attacking && sounds.attack,
    next.chitterAt !== previous.chitterAt && sounds.chitter,
  ];
  for (const sound of made)
    if (sound !== false)
      effect(game, { at: { x: self.x, y: self.y }, sound }, self);
}

/** Chitters once its time comes, while foraging or guarding. */
function chitter(
  state: MagpieState,
  now: number,
  config: MagpieConfig,
): MagpieState {
  if (now < state.chitterAt) return state;
  if (state.mode === "spook" || state.mode === "revenge") return state;
  return { ...state, chitterAt: now + between(Math.random, config.chitterGap) };
}

/** Drops what it carries where it stands, unclaimed, when hurt. */
function fumble(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
): MagpieState {
  if (state.carrying === null) return state;
  lay(game, self, state.carrying, { x: self.x, y: self.y });
  return { ...state, carrying: null };
}

function act(
  state: MagpieState,
  self: WorldEntity,
  game: Session,
  config: MagpieConfig,
  sounds: Sounds,
): MagpieState {
  switch (state.mode) {
    case "wander":
      return forage(state, self, game, config, sounds);
    case "guard":
      return patrol(state, self, game, config);
    case "spook":
    case "revenge":
      return chase(state, self, game, config);
  }
}

function definition(config: MagpieConfig): EntityDefinition<MagpieState> {
  const sounds: Sounds = {
    chitter: sound({ url: chitterUrl, range: config.sounds.chitter }),
    alarm: sound({ url: alarmUrl, range: config.sounds.alarm }),
    pickUp: sound({ url: pickUpUrl, range: config.sounds.pickUp }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: MagpieState,
    update(entity, state, dt, game) {
      const now = game.worldTime;
      const settled =
        state.nest === null ? settle(state, entity, game, config) : state;
      const hurt = hurtSinceLastStep(game, entity.id);
      const held = hurt === null ? settled : fumble(settled, entity, game);
      const thought = think(held, entity, game, config, hurt);
      const acted = act(thought, entity, game, config, sounds);
      const next = chitter(
        strikeIf(
          acted,
          now,
          inReach(game, entity, acted, config).length > 0,
          config.attackCooldown,
        ),
        now,
        config,
      );
      cue(entity, state, next, game, sounds);
      const calm = next.mode === "wander" || next.mode === "guard";
      const speed = calm ? config.wanderSpeed : config.chaseSpeed;
      return walk(entity, next, speed, dt);
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return strikeEach(inReach(game, entity, state, config), config.damage);
    },
    dies(entity, state, game) {
      if (state.carrying !== null) spawnWorldItem(game, entity, state.carrying);
    },
    draw(ctx, entity, state, _now, game) {
      drawEmoji(ctx, entity, GLYPH, entity.radius * 2);
      drawRing(ctx, entity, COLOURS[state.mode], 2, 0);
      const carried =
        state.carrying === null
          ? undefined
          : game.itemDefinitions.get(state.carrying)?.emoji;
      if (carried !== undefined)
        drawHeldItem(ctx, entity, state.facing, carried);
    },
  };
}

/**
 * The magpie beetle: arrives in groups of a few, in the dark, out of sight, and settles a nest
 * where it lands. Each roams a ring of spots round the nest, and any scrap it sees it carries home,
 * held up for all to see, and lays by the nest as the nest's own; then it guards a while. A player
 * it sees near the nest sets it guarding; one that comes close while it is away spooks it into a
 * short chase, as does being hurt, which also makes it drop what it carries. A player who picks up
 * scrap the nest claimed draws the whole nest's revenge: they hunt that player, light or no light,
 * until the player dies or leaves the stolen scrap behind. It keeps out of light otherwise.
 */
export const magpie = defineEntity(NAME, (config: MagpieConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    scatter: config.spawn,
    fresh: (_seed: number, game: Session) => freshMagpie(game.worldTime),
  }),
}));
