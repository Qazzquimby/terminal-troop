import { countBy, mean, sortBy, sum } from "lodash-es";
import { z } from "zod";
import { arrive, arrivingKinds, entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import { moveContent } from "../moves/index.js";
import type { MovesConfig } from "../moves/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
} from "../render/index.js";
import {
  createCamera,
  createFlashes,
  createMapMemory,
  createRipples,
  draw,
  snapCamera,
} from "../render/index.js";
import {
  createPlayer,
  createSession,
  entityDelta,
  entitySnapshot,
  isAreaFree,
  mulberry32,
  profileSteps,
  registerContent,
  updateSession,
} from "../sim/index.js";
import type {
  Controls,
  EntitySnapshot,
  Point,
  Rng,
  Session,
  SimClockConfig,
  SimConfig,
} from "../sim/index.js";
import { testSfx } from "./sim-config.js";

/*
 * A headless benchmark of the host's step with many entities (#433): a config's world (the
 * shipped one, for the sweep), its players held still, and N monsters of the kinds the spawner brings, in proportion to
 * their spawn weights, placed in one of three regimes:
 *
 * - dormant: past every kind's `dormantBeyond` from every player, where a kind that can lie
 *   dormant does. Kinds that roam the whole world never do, so they still run.
 * - active: past the engagement range of every player but short of `dormantBeyond`: awake, but
 *   not acting on one another.
 * - interacting: within the engagement range of the players, crowded together, acting on one
 *   another and on the players.
 *
 * A monster that dies or leaves is replaced between steps, outside the timing, so N holds.
 */

export const REGIMES = ["dormant", "active", "interacting"] as const;
export type Regime = (typeof REGIMES)[number];

export interface BenchOptions {
  readonly regime: Regime;
  /** Monsters kept in the world, on top of what it starts with. */
  readonly count: number;
  /** Steps run before timing starts. */
  readonly warmup: number;
  /** Steps timed. */
  readonly steps: number;
  /** Players, all alive and held still, near the world's rally point. */
  readonly players: number;
  /** Also time a frame drawn each step, on a canvas that draws nothing. */
  readonly render: boolean;
  /** Also run the steps again with the step profile on, for a breakdown by part and kind. */
  readonly breakdown: boolean;
  /** Seeds where monsters are placed and every roll they make. */
  readonly seed: number;
  /** Which kinds, how many of each: see `Mix`. */
  readonly mix: Mix;
}

/**
 * How the monsters divide among kinds: "shipped", in proportion to the spawner's weights, so a
 * weight tweak changes what is timed; or fixed weights by kind name, such as `REFERENCE_MIX`, so
 * commits compare like with like. Fixed weights are scaled to the count, and a kind the world
 * has not registered is left out, the rest keeping their counts.
 */
export type Mix = "shipped" | Readonly<Record<string, number>>;

/** A fixed mix, counts at N = 100: the shipped one as of #470. */
export const REFERENCE_MIX: Readonly<Record<string, number>> = {
  zombie: 22,
  exploder: 15,
  sleeper: 11,
  hoarder: 11,
  tricycle: 9,
  thumper: 4,
  mimic: 4,
  apexPredator: 3,
  snail: 2,
  blindDog: 2,
  stalker: 2,
  mineLayer: 2,
  livingWall: 2,
  gloom: 2,
  doppelganger: 2,
  birthdayBoy: 2,
  peeper: 2,
  statue: 1,
  giantSnail: 1,
  ghostGirl: 1,
};

/** A fixed world, the shipped one as of #470, so a resized map does not read as a regression. */
export const REFERENCE_WORLD = { cols: 100, rows: 60, seed: 1 } as const;

/** `config` on `REFERENCE_WORLD`'s map. */
export const onReferenceWorld = (config: BenchConfig): BenchConfig => ({
  ...config,
  sim: { ...config.sim, world: { ...config.sim.world, ...REFERENCE_WORLD } },
});

export const benchDefaults: Omit<BenchOptions, "regime" | "count"> = {
  warmup: 60,
  steps: 300,
  players: 4,
  render: true,
  breakdown: true,
  seed: 1,
  mix: "shipped",
};

/** Milliseconds a step took: its mean, median, 95th percentile and worst. */
export interface Timing {
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

export interface BenchResult {
  readonly regime: Regime;
  readonly count: number;
  /** Entities the world started with before the monsters were added: doors, items and the like. */
  readonly baseline: number;
  /** Entities in the world at the end, mines, corpses and drops included. */
  readonly entitiesAtEnd: number;
  /** Monsters replaced over the timed steps, having died or gone. */
  readonly replaced: number;
  readonly step: Timing;
  /** A frame drawn on a canvas that draws nothing: what the draw costs before rasterising. */
  readonly draw: Timing | null;
  /** What building one entity update for the network costs: the snapshot, delta and JSON. */
  readonly send: Timing;
  /** Mean ms a step for each timed part, most first; empty unless asked for. */
  readonly parts: readonly (readonly [string, number])[];
  /** How many of each kind the world held at the end, by name. */
  readonly kinds: ReadonlyMap<string, number>;
}

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 1, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};

/** The tuning a bench runs on: the shipped config, for the sweep. */
export interface BenchConfig {
  readonly sim: SimConfig;
  readonly entities: EntitiesConfig;
  readonly items: ItemsConfig;
  readonly moves: MovesConfig;
  readonly clock: SimClockConfig;
  /** How often, a second, the host sends the entities. */
  readonly sendHz: number;
  readonly camera: CameraConfig;
  readonly flashes: FlashConfig;
  readonly ripples: RippleConfig;
  readonly mapMemory: MapMemoryConfig;
}

/** `config`'s session, with players that cannot die, so the regimes hold while timed. */
const benchSim = (config: BenchConfig): SimConfig => ({
  ...config.sim,
  player: { ...config.sim.player, maxHealth: 1e12 },
});

/** `config`'s content, with a spawner that brings nothing: the bench places every monster. */
const benchContent = (config: BenchConfig) => [
  ...entityContent({
    ...config.entities,
    spawner: { ...config.entities.spawner, period: 1e9, headStart: 0 },
  }),
  ...itemContent(config.items),
  ...moveContent(config.moves),
];

/** The nearest player's distance from `at`. */
function nearestPlayer(game: Session, at: Point): number {
  return Math.min(
    ...[...game.players.values()].map((player) =>
      Math.hypot(player.x - at.x, player.y - at.y),
    ),
  );
}

/** The band of distances from the nearest player each regime places monsters in. */
function bandOf(
  config: BenchConfig,
  regime: Regime,
): {
  readonly near: number;
  readonly far: number;
} {
  const engagement = config.sim.engagement.range;
  const dormant = Math.max(
    ...Object.values(config.entities).map((kind) =>
      "dormantBeyond" in kind ? (kind.dormantBeyond ?? 0) : 0,
    ),
  );
  const cell = config.sim.world.cell;
  switch (regime) {
    case "dormant":
      return { near: dormant + cell * 4, far: Infinity };
    case "active":
      return { near: engagement + cell * 2, far: dormant - cell * 2 };
    case "interacting":
      return { near: cell * 2, far: engagement - cell };
  }
}

/** A free spot `radius` round in `regime`'s band; throws when tries find none. */
function placeIn(
  game: Session,
  config: BenchConfig,
  regime: Regime,
  radius: number,
  rng: Rng,
): Point {
  const { near, far } = bandOf(config, regime);
  const { W, H, map } = game.world;
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const at = { x: rng() * W, y: rng() * H };
    const distance = nearestPlayer(game, at);
    if (
      distance >= near &&
      distance <= far &&
      isAreaFree(map, at.x, at.y, radius)
    )
      return at;
  }
  throw new Error(
    `Nowhere free in the ${regime} band for radius ${String(radius)}`,
  );
}

/**
 * `count` kinds as `mix` divides them, the heaviest first: in proportion to the spawner's weights,
 * or to fixed ones, leaving out a kind the world lacks.
 */
function mixOf(game: Session, count: number, mix: Mix): string[] {
  const arriving = arrivingKinds(game);
  const known = new Set(arriving.map(({ kind }) => kind));
  const weighted =
    mix === "shipped"
      ? arriving
      : Object.entries(mix).map(([kind, weight]) => ({ kind, weight }));
  const shared = largestRemainders(
    weighted.filter(({ weight }) => weight > 0),
    count,
  );
  return [...shared]
    .filter(([kind]) => known.has(kind))
    .flatMap(([kind, n]) => Array<string>(n).fill(kind));
}

/** `count` shared among `kinds` in proportion to their weights, summing to `count`. */
function largestRemainders(
  kinds: readonly { readonly kind: string; readonly weight: number }[],
  count: number,
): Map<string, number> {
  const total = sum(kinds.map(({ weight }) => weight));
  // Largest remainders, so the mix sums to `count` and every kind with weight shows up early.
  const shares = kinds.map((kind) => ({
    kind: kind.kind,
    exact: (kind.weight / total) * count,
  }));
  const counts = new Map(
    shares.map(({ kind, exact }) => [kind, Math.floor(exact)]),
  );
  const left = count - sum([...counts.values()]);
  sortBy(shares, ({ exact }) => Math.floor(exact) - exact)
    .slice(0, left)
    .forEach(({ kind }) => counts.set(kind, (counts.get(kind) ?? 0) + 1));
  return counts;
}

/** A world on `config`, its players gathered at the rally point. */
function benchWorld(config: BenchConfig, players: number): Session {
  const sim = benchSim(config);
  const game = createSession("p0", "P0", "BENCH", "standard", testSfx(), sim, {
    rng: mulberry32(1),
  });
  registerContent(game, benchContent(config));
  for (const content of game.contents) content.populate(game);
  const rng = mulberry32(2);
  const { cell } = sim.world;
  for (let index = 1; index < players; index++) {
    const id = `p${String(index)}`;
    const at = { x: game.local.x, y: game.local.y };
    // Within a few cells of the local player, as a crew keeps together.
    for (let attempt = 0; attempt < 1000; attempt++) {
      at.x = game.local.x + (rng() - 0.5) * cell * 6;
      at.y = game.local.y + (rng() - 0.5) * cell * 6;
      if (isAreaFree(game.world.map, at.x, at.y, sim.player.radius)) break;
    }
    game.players.set(id, createPlayer(id, id.toUpperCase(), at, sim));
  }
  return game;
}

/**
 * A 2D context, and everything a draw makes from one, that draws nothing: any property is a
 * function that does nothing and gives the same back, and any number read from it is 0.
 */
function inert(): unknown {
  // A function, not an arrow, so it can also be constructed, as `new ImageData(...)` is.
  function target(): undefined {
    return undefined;
  }
  const handler: ProxyHandler<typeof target> = {
    get: (_target, key) =>
      key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : self,
    set: () => true,
    apply: () => self,
    construct: () => self,
  };
  const self: object = new Proxy(target, handler);
  return self;
}

const nothing = inert();
const blankContext = z.custom<CanvasRenderingContext2D>().parse(nothing);

/** Gives the draw's off-screen layers a `document` and `ImageData` that draw nothing. */
function stubCanvasGlobals(): void {
  if (!("document" in globalThis))
    Object.assign(globalThis, { document: { createElement: () => nothing } });
  if (!("ImageData" in globalThis))
    Object.assign(globalThis, { ImageData: nothing });
}

/** A frame's draw, from the local player's view, on a canvas that draws nothing. */
function framer(game: Session, config: BenchConfig): (now: number) => void {
  stubCanvasGlobals();
  const camera = createCamera(config.sim.view, config.camera);
  const flashes = createFlashes(config.flashes);
  const ripples = createRipples(config.ripples, mulberry32(3));
  const stored = new Map<string, string>();
  const memory = createMapMemory(config.mapMemory, {
    get: (key) => stored.get(key) ?? null,
    set: (key, value) => stored.set(key, value),
    remove: (key) => stored.delete(key),
  });
  memory.enter(
    { room: "BENCH", world: "standard", seed: game.seed },
    game.world.map,
  );
  return (now) => {
    snapCamera(camera, game.local);
    draw(
      blankContext,
      game,
      camera,
      now,
      1,
      game.local,
      () => false,
      flashes,
      ripples,
      memory,
    );
  };
}

function timing(samples: readonly number[]): Timing {
  const sorted = sortBy(samples);
  return {
    mean: sorted.length === 0 ? 0 : mean(sorted),
    median: sorted[sorted.length >> 1] ?? 0,
    p95:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Times `run`, in ms. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** Keeps `count` monsters of `mix` in `regime`, `alive` holding the ids of those placed. */
function keeper(
  game: Session,
  config: BenchConfig,
  regime: Regime,
  mix: readonly string[],
  rng: Rng,
) {
  const radii = new Map(
    arrivingKinds(game).map(({ kind, radius }) => [kind, radius]),
  );
  const alive = new Map<string, string>();
  let replaced = 0;
  const place = (kind: string) => {
    const before = game.nextEntityId;
    arrive(
      game,
      kind,
      placeIn(game, config, regime, radii.get(kind) ?? 20, rng),
    );
    for (let id = before; id < game.nextEntityId; id++)
      alive.set(id.toString(36), kind);
  };
  mix.forEach(place);
  return {
    /** Replaces each monster gone since the last call; how many it replaced. */
    topUp(): number {
      const gone = [...alive].filter(
        ([id]) => (game.entities.get(id)?.health ?? 0) <= 0,
      );
      for (const [id, kind] of gone) {
        alive.delete(id);
        place(kind);
      }
      replaced += gone.length;
      return gone.length;
    },
    replaced: () => replaced,
  };
}

/** The parts' timings, in mean ms a step, most first. */
function partsOf(
  totals: Map<string, number>,
  steps: number,
): [string, number][] {
  return sortBy(
    [...totals].map(([label, ms]): [string, number] => [label, ms / steps]),
    ([, ms]) => -ms,
  );
}

/** Runs one regime at one count and times it. Seeds `Math.random` while it runs. */
export function runBench(
  config: BenchConfig,
  options: BenchOptions,
): BenchResult {
  const random = Math.random;
  Math.random = mulberry32(options.seed);
  try {
    return measure(config, options);
  } finally {
    Math.random = random;
    profileSteps(null);
  }
}

function measure(config: BenchConfig, options: BenchOptions): BenchResult {
  const game = benchWorld(config, options.players);
  const baseline = game.entities.size;
  const kept = keeper(
    game,
    config,
    options.regime,
    mixOf(game, options.count, options.mix),
    mulberry32(options.seed + 7),
  );
  const dt = config.clock.fixedDt;
  const frame = options.render ? framer(game, config) : null;
  for (let step = 0; step < options.warmup; step++) {
    updateSession(game, still, dt);
    kept.topUp();
  }
  const replacedBefore = kept.replaced();

  const steps: number[] = [];
  const draws: number[] = [];
  const sends: number[] = [];
  let sent = new Map<string, EntitySnapshot>();
  const sendEvery = Math.max(1, Math.round(1 / (config.sendHz * dt)));
  for (let step = 0; step < options.steps; step++) {
    steps.push(
      timed(() => {
        updateSession(game, still, dt);
      }),
    );
    if (frame !== null)
      draws.push(
        timed(() => {
          frame(game.time * 1000);
        }),
      );
    if (step % sendEvery === 0)
      sends.push(
        timed(() => {
          const entities = entitySnapshot(game);
          JSON.stringify(entityDelta(sent, entities));
          sent = new Map(entities.map((entity) => [entity.id, entity]));
        }),
      );
    kept.topUp();
  }
  const entitiesAtEnd = game.entities.size;
  const replaced = kept.replaced() - replacedBefore;

  const totals = new Map<string, number>();
  const profile = {
    add: (label: string, ms: number) =>
      totals.set(label, (totals.get(label) ?? 0) + ms),
  };
  if (options.breakdown)
    for (let step = 0; step < options.steps; step++) {
      profileSteps(profile);
      updateSession(game, still, dt);
      profileSteps(null);
      kept.topUp();
    }

  return {
    regime: options.regime,
    count: options.count,
    baseline,
    entitiesAtEnd,
    replaced,
    step: timing(steps),
    draw: frame === null ? null : timing(draws),
    send: timing(sends),
    parts: partsOf(totals, options.steps),
    kinds: kindCounts(game),
  };
}

/** How many of each kind the world holds, by name. */
function kindCounts(game: Session): Map<string, number> {
  const names = new Map([...game.kindIds].map(([name, id]) => [id, name]));
  return new Map(
    Object.entries(
      countBy([...game.entities.values()], ({ kind }) => names.get(kind)),
    ),
  );
}

/** The kinds' parts summed over their phases, from a result's parts: `kind:<name>` by ms a step. */
export function byKind(
  parts: readonly (readonly [string, number])[],
): [string, number][] {
  const kinds = new Map<string, number>();
  for (const [label, ms] of parts) {
    const match = /^kind:([^:]+):/.exec(label);
    if (match?.[1] !== undefined)
      kinds.set(match[1], (kinds.get(match[1]) ?? 0) + ms);
  }
  return sortBy([...kinds], ([, ms]) => -ms);
}

/**
 * The step's parts with every kind folded into `entities:run`, `entities:still` (stunned or
 * dormant) and `entities:move`; `entities` itself is all of the entities' update, those included.
 */
export function byPhase(
  parts: readonly (readonly [string, number])[],
): [string, number][] {
  const phases = new Map<string, number>();
  for (const [label, ms] of parts) {
    const match = /^kind:[^:]+:(.+)$/.exec(label);
    const key = match?.[1] === undefined ? label : `entities:${match[1]}`;
    phases.set(key, (phases.get(key) ?? 0) + ms);
  }
  return sortBy([...phases], ([, ms]) => -ms);
}
