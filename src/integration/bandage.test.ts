import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  CORPSE_ITEM,
  giveItem,
  hurtPlayer,
  isGhost,
  itemIn,
  itemInstances,
  spawnEntity,
} from "../sim/index.js";
import type { Controls, Point } from "../sim/index.js";
import { crew as crewAt, idle, playerOn, sessionOf } from "./crew.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSimConfig,
} from "./sim-config.js";

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

const { maxHealth } = testSimConfig.player;
const { bandage } = testItemsConfig;
/** The host far off; the guest `b`, with `c` just in front of it, to its right. */
const SPOTS = {
  a: { x: 750, y: 500 },
  b: { x: 300, y: 300 },
  c: { x: 300 + testSimConfig.player.radius * 2 + 4, y: 300 },
} as const;

const crew = (...ids: string[]) =>
  crewAt(
    {
      spots: SPOTS,
      content: [...entityContent(entities), ...itemContent(items)],
    },
    ...ids,
  );

/** Uses the held item facing `at`. */
const useToward = (at: Point): Controls => ({ ...idle, use: true, aim: at });
/** Faces away from everyone, to the left, using the held item. */
const useAway = useToward({ x: 0, y: SPOTS.b.y });

/** Sets up the crew with `b` holding a bandage in its second slot, the shovel in its first. */
async function bandaged(...ids: string[]) {
  const made = await crew(...ids);
  const host = sessionOf(made.room("a"));
  expect(giveItem(host, "b", "bandage")).toBe(true);
  made.run(300);
  sessionOf(made.room("b")).local.held = 1;
  made.run(100);
  return { ...made, host, guest: sessionOf(made.room("b")) };
}

test("a guest wraps a bandage on itself: three quarters of its health back, everywhere, and it is spent", async () => {
  const { rooms, room, run, step, host, guest } = await bandaged("a", "b");
  hurtPlayer(host, playerOn(room("a"), "b"), 90);
  run(300);
  step({ b: useAway });
  run(500);
  for (const each of rooms.values())
    expect(playerOn(each, "b").health).toBe(
      maxHealth - 90 + maxHealth * bandage.heal,
    );
  expect(itemIn(host, "b", 1)).toBeNull();
  expect(guest.local.inventory[1]).toBeNull();
});

test("a bandage heals no further than full health", async () => {
  const { room, run, step, host } = await bandaged("a", "b");
  hurtPlayer(host, playerOn(room("a"), "b"), 10);
  run(300);
  step({ b: useAway });
  run(500);
  expect(playerOn(room("a"), "b").health).toBe(maxHealth);
  expect(playerOn(room("b"), "b").health).toBe(maxHealth);
  expect(itemIn(host, "b", 1)).toBeNull();
});

test("a bandage with nobody wounded to wrap is kept", async () => {
  const { run, step, host, guest } = await bandaged("a", "b");
  step({ b: useAway });
  run(500);
  expect(itemIn(host, "b", 1)).toBe("bandage");
  expect(guest.local.inventory[1]?.id).toBe("bandage");
});

test("a bandage goes on the wounded body in front of its user before the user itself", async () => {
  const { room, run, step, host } = await bandaged("a", "b", "c");
  hurtPlayer(host, playerOn(room("a"), "b"), 50);
  hurtPlayer(host, playerOn(room("a"), "c"), 80);
  run(300);
  step({ b: useToward(SPOTS.c) });
  run(500);
  expect(playerOn(room("c"), "c").health).toBe(
    maxHealth - 80 + maxHealth * bandage.heal,
  );
  expect(playerOn(room("a"), "b").health).toBe(maxHealth - 50);
  expect(itemIn(host, "b", 1)).toBeNull();
});

test("a bandage wrapped on a corpse brings its player back where it lay, on a quarter of its health, on every client", async () => {
  const { rooms, room, run, step, host, guest } = await bandaged("a", "b", "c");
  hurtPlayer(host, playerOn(room("a"), "c"), Infinity);
  run(500);
  expect(isGhost(playerOn(room("a"), "c"))).toBe(true);
  expect(itemInstances(host, CORPSE_ITEM)).toHaveLength(1);
  step({ b: useToward(SPOTS.c) });
  run(1000);
  for (const each of rooms.values()) {
    const c = playerOn(each, "c");
    expect(isGhost(c)).toBe(false);
    expect(c.health).toBe(maxHealth * bandage.revive);
    expect(Math.hypot(c.x - SPOTS.c.x, c.y - SPOTS.c.y)).toBeLessThanOrEqual(
      testSimConfig.arrival.spread + 1,
    );
    expect(itemInstances(sessionOf(each), CORPSE_ITEM)).toEqual([]);
  }
  expect(itemIn(host, "b", 1)).toBeNull();
  expect(guest.local.inventory[1]).toBeNull();
});

test("a bandage heals any body in front of its user, a monster as well as a player", async () => {
  const { run, step, host } = await bandaged("a", "b");
  const zombie = spawnEntity(host, "zombie", SPOTS.c.x + 4, SPOTS.c.y, {
    mode: "wander",
    seed: 1,
    route: [],
    target: null,
    standUntil: host.worldTime + 60,
    noiseTarget: null,
    barkAt: host.worldTime + 60,
    attackAt: host.worldTime + 60,
    attacking: false,
    restUntil: host.worldTime + 60,
    facing: 0,
  });
  zombie.health = 1;
  run(100);
  step({ b: useToward(zombie) });
  run(500);
  expect(zombie.health).toBe(1 + zombie.maxHealth * bandage.heal);
  expect(itemIn(host, "b", 1)).toBeNull();
});
