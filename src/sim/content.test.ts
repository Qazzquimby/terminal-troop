import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { defineEntity, defineItem, entityKind } from "./index.js";
import type {
  Content,
  ContentConfig,
  EntitySpec,
  SpawnRule,
  WorldContent,
} from "./index.js";
import { isAreaFree, mulberry32, randomFreePosition } from "./map.js";
import type { Point, WorldKind } from "./map.js";
import type { Session } from "./session.js";
import { createSession } from "./session.js";

const RADIUS = 15;

/** A still body of RADIUS. */
const shape = { radius: RADIUS, maxHealth: 10, draw: () => undefined };

/** The same, its state a number. */
const body: EntitySpec<number> = { ...shape, data: z.number() };

function session(code = "SPAWN", kind: WorldKind = "standard"): Session {
  const game = createSession("me", "ME", code, kind, testSfx(), testSimConfig);
  // Players start at random; this one stands at the same spot every time.
  Object.assign(game.local, randomFreePosition(game.world, 14, mulberry32(9)));
  return game;
}

/** `game` with `world` registered and populated. */
function populated(world: WorldContent, game = session()): Session {
  world.register(game);
  world.populate(game);
  return game;
}

/** A one-kind entry named "rock" that spawns by `rule`. */
const rocks = defineEntity("rock", (rule: SpawnRule<number> | undefined) => ({
  ...body,
  ...(rule === undefined ? {} : { spawn: rule }),
}));

/** `game` holding rocks that spawn by `rule`. */
const rock = (rule: SpawnRule<number> | undefined, game = session()) =>
  populated(rocks.create({ rock: rule }), game);

const placed = (game: Session): Point[] =>
  [...game.entities.values()].map(({ x, y }) => ({ x, y }));

describe("defineEntity", () => {
  test("registers its kind under its name, configured by the slice under that name", () => {
    const sized = defineEntity("pebble", (radius: number) => ({
      ...body,
      radius,
    }));
    const game = populated(sized.create({ pebble: 4 }));
    expect(game.kindIds.get("pebble")).toBe(1);
    expect(game.entityTypes.get(1)?.radius).toBe(4);
  });

  test("with no spawn rule a new world starts with none", () => {
    expect(rock(undefined).entities.size).toBe(0);
  });
});

describe("scatter", () => {
  const scatter = (count: number | { density: number; min: number }) =>
    ({
      at: "scatter",
      count,
      seed: 3,
      clearance: 400,
      data: (rng) => rng(),
    }) satisfies SpawnRule<number>;

  test("places a fixed count on free floor", () => {
    const game = rock(scatter(5));
    expect(game.entities.size).toBe(5);
    for (const { x, y } of placed(game))
      expect(isAreaFree(game.world.map, x, y, RADIUS)).toBe(true);
  });

  test("places one per area of the world by density, and at least the minimum", () => {
    // 4000x3000 at 1 per million square pixels.
    expect(rock(scatter({ density: 1, min: 2 })).entities.size).toBe(12);
    expect(
      rock(scatter({ density: 1, min: 2 }), session("SPAWN", "dev")).entities
        .size,
    ).toBe(2);
  });

  test("keeps clear of the players where the world has room", () => {
    const game = rock(scatter(5));
    for (const { x, y } of placed(game))
      expect(
        Math.hypot(x - game.local.x, y - game.local.y),
      ).toBeGreaterThanOrEqual(400);
  });

  test("a world too small for the clearance still gets them all", () => {
    expect(rock(scatter(3), session("SPAWN", "dev")).entities.size).toBe(3);
  });

  test("spots and data are seeded by the room", () => {
    const snapshot = (game: Session) =>
      [...game.entities.values()].map(({ x, y, data }) => ({ x, y, data }));
    const spawned = snapshot(rock(scatter(4)));
    expect(snapshot(rock(scatter(4)))).toEqual(spawned);
    expect(snapshot(rock(scatter(4), session("OTHER")))).not.toEqual(spawned);
    expect(new Set(spawned.map(({ data }) => data)).size).toBe(4);
  });
});

describe("rally", () => {
  test("puts one at the rally point, wherever the hosting player is", () => {
    const game = session("RALLY");
    const { x, y } = game.rally;
    rock({ at: "rally", data: 7 }, game);
    expect([...game.entities.values()]).toMatchObject([{ x, y, data: 7 }]);
  });

  test("moves it to the nearest free spot when the rally point has no room for it", () => {
    // The dev square's pillar fills x 200-300, y 50-150.
    const game = session("RALLY", "dev");
    Object.assign(game, { rally: { x: 250, y: 100 } });
    rock({ at: "rally", data: 0 }, game);
    const [moved] = placed(game);
    expect(moved).toBeDefined();
    expect(
      isAreaFree(game.world.map, moved?.x ?? 0, moved?.y ?? 0, RADIUS),
    ).toBe(true);
  });
});

test("a spawn function places them itself", () => {
  const game = rock(
    (spawn) => {
      spawn({ x: 100, y: 300 }, 1);
      spawn({ x: 500, y: 300 }, 2);
    },
    session("FN", "dev"),
  );
  expect([...game.entities.values()]).toMatchObject([
    { x: 100, y: 300, data: 1 },
    { x: 500, y: 300, data: 2 },
  ]);
});

test("content of several kinds registers them all and spawns them together", () => {
  const coffin = entityKind("coffin", { ...shape, data: z.object({}) });
  const vampire = entityKind("vampire", {
    ...shape,
    data: z.object({ coffin: z.string() }),
  });
  const vampires: Content<"vampires", number> = {
    name: "vampires",
    create: ({ vampires: count }) => ({
      name: "entity/vampires",
      register(game) {
        coffin.register(game);
        vampire.register(game);
      },
      populate(game) {
        for (let i = 0; i < count; i++) {
          const home = coffin.spawn(game, { x: 100 + i * 300, y: 300 }, {});
          vampire.spawn(
            game,
            { x: home.x + 40, y: home.y },
            { coffin: home.id },
          );
        }
      },
    }),
  };
  const game = populated(
    vampires.create({ vampires: 2 }),
    session("VAMP", "dev"),
  );
  expect([...game.kindIds]).toEqual([
    ["coffin", 1],
    ["vampire", 2],
  ]);
  expect(
    [...game.entities.values()].map(({ id, kind, x, data }) => ({
      id,
      kind,
      x,
      data,
    })),
  ).toEqual([
    { id: "1", kind: 1, x: 100, data: {} },
    { id: "2", kind: 2, x: 140, data: { coffin: "1" } },
    { id: "3", kind: 1, x: 400, data: {} },
    { id: "4", kind: 2, x: 440, data: { coffin: "3" } },
  ]);
});

describe("defineItem", () => {
  /** An item named `name` that does nothing, used at most every `cooldown` seconds. */
  const inert = <N extends string>(name: N, startingSlot?: number) =>
    defineItem(name, (cooldown: number) => ({
      name: name.toUpperCase(),
      emoji: "🧪",
      ...(startingSlot === undefined ? {} : { startingSlot }),
      cooldown,
      apply: () => undefined,
      show: (_game, at) => ({ center: { x: at.x, y: at.y }, hit: false }),
      draw: () => undefined,
    }));

  const stocked = (game: Session) =>
    game.local.inventory.map((item) => item?.id ?? null);

  test("registers the item under its name, configured by the slice under that name", () => {
    const game = populated(inert("flask").create({ flask: 2 }));
    expect(game.itemDefinitions.get("flask")).toEqual({
      id: "flask",
      name: "FLASK",
      emoji: "🧪",
    });
    expect(game.items.get("flask")?.cooldown).toBe(2);
    expect(game.entities.size).toBe(0);
    expect(stocked(game)).toEqual([null, null, null, null]);
  });

  test("puts each starting item in its own slot, whatever order the items register in", () => {
    const flask = inert("flask", 2);
    const vial = inert("vial", 0);
    const config = { flask: 1, vial: 1 };
    for (const list of [
      [flask, vial],
      [vial, flask],
    ]) {
      const game = session();
      for (const entry of list) entry.create(config).register(game);
      expect(stocked(game)).toEqual(["vial", null, "flask", null]);
    }
  });

  test("two items starting in one slot are refused", () => {
    const game = session();
    inert("flask", 1).create({ flask: 1 }).register(game);
    const vial = inert("vial", 1).create({ vial: 1 });
    expect(() => {
      vial.register(game);
    }).toThrow(RangeError);
  });

  test("a list of entities and items takes every entry's slice, typed by the entry", () => {
    const flask = inert("flask");
    type Config = ContentConfig<typeof rocks | typeof flask>;
    expectTypeOf({ rock: undefined, flask: 1 }).toExtend<Config>();
    expectTypeOf({ rock: undefined }).not.toExtend<Config>();
    expectTypeOf({ rock: undefined, flask: "1" }).not.toExtend<Config>();
    const config: Config = { rock: undefined, flask: 1 };
    expect(populated(flask.create(config)).items.has("flask")).toBe(true);
  });
});
