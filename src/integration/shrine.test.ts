import { afterEach, expect, test, vi } from "vitest";
import { entityContent, freshDoppelganger } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { z } from "zod";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import type { Room } from "../room/index.js";

import {
  hurt,
  hurtPlayer,
  isGhost,
  itemInstances,
  registerEntityType,
  spawnEntity,
  spawnWorldItem,
  voiceRoutes,
} from "../sim/index.js";
import type {
  Point,
  Session,
  WorldContent,
  WorldEntity,
} from "../sim/index.js";
import { crew as crewAt, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** No zombies, now or later. */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

/** No scrap on the ground, so nothing lies about but what the test lays. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const SPOTS = {
  a: { x: 150, y: 300 },
  b: { x: 750, y: 450 },
  c: { x: 750, y: 150 },
} as const;
/** A shrine fresh from the world, as a new world lays it. */
const FRESH = { offerings: 0, whisperAt: 0 };
/** Where the test's shrine stands, well apart from every player. */
const SHRINE = { x: 450, y: 150 };

const { toughness } = testItemsConfig.heart;

/**
 * A tough body, as hard to kill as the sleeper; a soft one, just short of it; and a biter that,
 * on its first step, deals every tough or soft body all its health.
 */
const bodies: WorldContent = {
  name: "entity/test-bodies",
  register(session) {
    for (const [name, maxHealth] of [
      ["tough", toughness],
      ["soft", toughness - 1],
    ] as const)
      registerEntityType(session, name, {
        radius: 8,
        maxHealth,
        collides: false,
        data: z.object({}),
        draw: () => undefined,
      });
    registerEntityType(session, "biter", {
      radius: 8,
      maxHealth: 10,
      collides: false,
      data: z.object({ steps: z.number() }),
      update: (_entity, data) => ({ steps: data.steps + 1 }),
      strikes: (_entity, { steps }, game) =>
        steps !== 1
          ? []
          : [...game.entities.values()]
              .filter((other) =>
                ["tough", "soft"].some(
                  (kind) => other.kind === game.kindIds.get(kind),
                ),
              )
              .map((other) => ({ target: other.id, amount: Infinity })),
      draw: () => undefined,
    });
  },
  populate: () => undefined,
};

const crew = (...ids: string[]) =>
  crewAt(
    {
      spots: SPOTS,
      content: [...entityContent(entities), ...itemContent(items), bodies],
    },
    ...ids,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

const kill = (room: Room, id: string): void => {
  hurtPlayer(sessionOf(room), playerOn(room, id), Infinity);
};

const lying = (game: Session, item: string): Point[] =>
  itemInstances(game, item)
    .filter((instance) => "lying" in instance.place)
    .map((instance) => instance.at);

const shrinesOf = (game: Session): WorldEntity[] => {
  const kind = game.kindIds.get("shrine");
  return [...game.entities.values()].filter((each) => each.kind === kind);
};

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

test("a body as hard to kill as the sleeper drops a heart where it falls; a softer one does not", async () => {
  const { room, run } = await crew("a");
  const host = sessionOf(room("a"));
  const tough = spawnEntity(host, "tough", 300, 450, {});
  spawnEntity(host, "soft", 600, 150, {});
  spawnEntity(host, "biter", 450, 300, { steps: 0 });
  const at = { x: tough.x, y: tough.y };
  run(500);
  expect(lying(host, "heart")).toEqual([at]);
});

test("a heart laid on a shrine brings a ghost back beside it, and is gone", async () => {
  const { rooms, room, run } = await crew("a", "b");
  const host = sessionOf(room("a"));
  spawnEntity(host, "shrine", SHRINE.x, SHRINE.y, FRESH);
  kill(room("a"), "b");
  run(500);
  expect(isGhost(playerOn(room("a"), "b"))).toBe(true);
  spawnWorldItem(host, { x: SHRINE.x + 10, y: SHRINE.y }, "heart");
  run(500);
  for (const each of rooms.values()) {
    const b = playerOn(each, "b");
    expect(isGhost(b)).toBe(false);
    expect(distance(b, SHRINE)).toBeLessThan(150);
    expect(itemInstances(sessionOf(each), "heart")).toEqual([]);
  }
});

test("a heart laid on a shrine brings back a ghost whose body a doppelganger wears, and the doppelganger is gone", async () => {
  const { rooms, room, run } = await crew("a", "b");
  const host = sessionOf(room("a"));
  const doppelganger = host.kindIds.get("doppelganger");
  const doubles = () =>
    [...host.entities.values()].filter((each) => each.kind === doppelganger);
  spawnEntity(host, "shrine", SHRINE.x, SHRINE.y, FRESH);
  const killer = spawnEntity(
    host,
    "doppelganger",
    SPOTS.c.x,
    SPOTS.c.y,
    freshDoppelganger(1, { id: "a", name: "a" }),
  );
  hurt(host, playerOn(room("a"), "b"), Infinity, killer.id);
  run(100);
  expect(isGhost(playerOn(room("a"), "b"))).toBe(true);
  expect(itemInstances(host, "corpse")).toEqual([]);
  const worn = doubles().find((each) => each !== killer);
  if (worn === undefined) throw new Error("b did not get up as a doppelganger");
  spawnWorldItem(host, { x: SHRINE.x + 10, y: SHRINE.y }, "heart");
  run(500);
  expect(host.entities.has(worn.id)).toBe(false);
  for (const each of rooms.values()) {
    const b = playerOn(each, "b");
    expect(isGhost(b)).toBe(false);
    expect(distance(b, SHRINE)).toBeLessThan(150);
  }
});

test("a heart lies on a shrine untouched while there is no ghost to bring back", async () => {
  const { room, run } = await crew("a");
  const host = sessionOf(room("a"));
  spawnEntity(host, "shrine", SHRINE.x, SHRINE.y, FRESH);
  spawnWorldItem(host, { x: SHRINE.x + 10, y: SHRINE.y }, "heart");
  run(500);
  expect(lying(host, "heart")).toHaveLength(1);
  expect(shrinesOf(host)).toHaveLength(1);
});

test("a walkie laid on a shrine becomes a ghost walkie; past the first offering, one may crumble the shrine", async () => {
  const { room, run } = await crew("a");
  const host = sessionOf(room("a"));
  spawnEntity(host, "shrine", SHRINE.x, SHRINE.y, FRESH);
  spawnWorldItem(host, { x: SHRINE.x + 10, y: SHRINE.y }, "walkie");
  vi.spyOn(Math, "random").mockReturnValue(0);
  run(300);
  expect(lying(host, "walkie")).toEqual([]);
  expect(lying(host, "ghostWalkie")).toHaveLength(1);
  // The first is safe, even on the unluckiest draw.
  expect(shrinesOf(host)).toHaveLength(1);

  spawnWorldItem(host, { x: SHRINE.x - 10, y: SHRINE.y }, "walkie");
  run(300);
  expect(lying(host, "ghostWalkie")).toHaveLength(2);
  expect(shrinesOf(host)).toEqual([]);
});

test("the living hear a ghost only from a shrine, and a ghost hears whoever speaks by one", async () => {
  const { room, run, place } = await crew("a", "b");
  const host = sessionOf(room("a"));
  kill(room("a"), "b");
  run(500);
  const onA = sessionOf(room("a"));
  expect(voiceRoutes(onA, playerOn(room("a"), "b"), onA.local)).toEqual([]);

  spawnEntity(host, "shrine", SHRINE.x, SHRINE.y, FRESH);
  run(500);
  expect(voiceRoutes(onA, playerOn(room("a"), "b"), onA.local)).toEqual([
    { at: SHRINE, via: "air" },
  ]);
  const onB = sessionOf(room("b"));
  const fromA = () => voiceRoutes(onB, playerOn(room("b"), "a"), onB.local);
  expect(fromA().some((route) => route.at === null)).toBe(false);
  place("a", { x: SHRINE.x + 60, y: SHRINE.y });
  run(500);
  expect(fromA()).toContainEqual({ at: null, via: "air" });
});

test("a ghost walkie switched on plays every ghost and lets them hear whoever is by it", async () => {
  const { room, run } = await crew("a", "b");
  const host = sessionOf(room("a"));
  kill(room("a"), "b");
  run(500);
  const walkieAt = { x: 160, y: 300 };
  spawnWorldItem(host, walkieAt, "ghostWalkie");
  run(500);
  const onA = sessionOf(room("a"));
  expect(voiceRoutes(onA, playerOn(room("a"), "b"), onA.local)).toEqual([]);

  for (const { place } of itemInstances(host, "ghostWalkie"))
    if ("lying" in place) host.entities.delete(place.lying.id);
  spawnWorldItem(host, walkieAt, "ghostWalkie", undefined, { on: true });
  run(500);
  expect(voiceRoutes(onA, playerOn(room("a"), "b"), onA.local)).toEqual([
    { at: walkieAt, via: "radio" },
  ]);
  const onB = sessionOf(room("b"));
  expect(voiceRoutes(onB, playerOn(room("b"), "a"), onB.local)).toContainEqual({
    at: null,
    via: "radio",
  });
});
