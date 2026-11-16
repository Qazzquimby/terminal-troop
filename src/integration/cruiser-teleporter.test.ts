import { expect, test } from "vitest";
import { entityContent, placeStunTrap } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  cabinTeleporter,
  giveItem,
  hurtPlayer,
  itemInstances,
  itemsOf,
} from "../sim/index.js";
import type { CabinCommand, Point, Session } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** No scrap on the ground, so nothing lies about but what the test drops. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const { recall: config } = testEntitiesConfig;

const CRUISER = { x: 450, y: 300 };

/** Where `a` stands out in the world: further from the cruiser than clients glide a body. */
const OUT = { x: 850, y: 550 };

const near = (from: Point, to: Point, within: number): boolean =>
  Math.hypot(from.x - to.x, from.y - to.y) <= within;

/** Clients a, hosting, out in the world at `OUT`, and b inside the cruiser. */
async function teleporterCrew() {
  const made = await crew(
    {
      spots: { a: { x: 430, y: 400 }, b: { x: 470, y: 360 } },
      content: [
        ...entityContent({
          ...testEntitiesConfig,
          zombie: {
            ...testEntitiesConfig.zombie,
            spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
          },
          cruiser: { ...testEntitiesConfig.cruiser, length: 80, width: 48 },
        }),
        ...itemContent(items),
      ],
    },
    "a",
    "b",
  );
  const game = (id: string): Session => sessionOf(made.room(id));
  const host = game("a");
  const kind = host.kindIds.get("cruiser");
  const cruiser = [...host.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (cruiser === undefined) throw new Error("no cruiser");
  Object.assign(cruiser, { ...CRUISER, prevX: CRUISER.x, prevY: CRUISER.y });
  made.run(500);
  made.step({ b: { ...idle, interact: true } });
  made.run(500);
  expect(game("b").local.ride?.vehicle).toBe(cruiser.id);
  made.place("a", OUT);
  made.run(500);
  /** `id` asks `command` of the cabin. */
  const ask = (id: string, command: CabinCommand): void => {
    made.step({ [id]: { ...idle, cabin: command } });
  };
  return { made, game, host, cruiser, ask };
}

test("the cabin teleports a player beside the cruiser after its charge, leaving its items where it stood", async () => {
  const { made, game, host, cruiser, ask } = await teleporterCrew();
  expect(giveItem(host, "a", "shovel")).toBe(true);
  expect(giveItem(host, "a", "flashlight")).toBe(true);
  made.run(300);
  const carried = itemsOf(host, "a")
    .flatMap((item) => (item === null ? [] : [item.id]))
    .sort();
  expect(carried).toEqual(expect.arrayContaining(["flashlight", "shovel"]));

  ask("b", { teleport: "a" });
  made.run(1000);
  // Charging: a is still out there, and every client sees the teleporter busy with it.
  expect(near(playerOn(made.room("a"), "a"), OUT, 5)).toBe(true);
  for (const id of ["a", "b"])
    expect(cabinTeleporter(game(id), cruiser.id)).toEqual({ sending: "a" });

  made.run(config.seconds * 1000);
  const landed = playerOn(made.room("a"), "a");
  expect(near(landed, cruiser, config.spread + 1)).toBe(true);
  expect(itemsOf(host, "a").every((item) => item === null)).toBe(true);
  const dropped = itemInstances(host).filter(
    (instance) => "lying" in instance.place,
  );
  expect(dropped.map((instance) => instance.item).sort()).toEqual(carried);
  for (const instance of dropped)
    expect(near(instance.at, OUT, 100)).toBe(true);
  // Every client has a beside the cruiser, its own included, placed there rather than gliding,
  // and the teleporter free again.
  made.run(500);
  for (const id of ["a", "b"]) {
    const seen = playerOn(made.room(id), "a");
    expect(near(seen, landed, 2)).toBe(true);
    expect(cabinTeleporter(game(id), cruiser.id)).toEqual({ sending: null });
  }
  expect(game("a").local.inventory.every((item) => item === null)).toBe(true);
});

test("the teleporter sends for one body at a time, and never one inside a vehicle", async () => {
  const { made, cruiser, ask, game } = await teleporterCrew();
  // b is inside: there is nothing to send for.
  ask("b", { teleport: "b" });
  made.run(500);
  expect(cabinTeleporter(game("b"), cruiser.id)).toEqual({ sending: null });

  ask("b", { teleport: "a" });
  made.run(500);
  expect(cabinTeleporter(game("b"), cruiser.id)).toEqual({ sending: "a" });
});

test("a player that dies while it charges is not taken, and the teleporter is free again", async () => {
  const { made, host, cruiser, ask } = await teleporterCrew();
  ask("b", { teleport: "a" });
  made.run(1000);
  expect(cabinTeleporter(host, cruiser.id)).toEqual({ sending: "a" });
  const a = playerOn(made.room("a"), "a");
  hurtPlayer(host, a, a.maxHealth);
  made.run(config.seconds * 1000);
  expect(cabinTeleporter(host, cruiser.id)).toEqual({ sending: null });
  expect(near(a, OUT, 5)).toBe(true);
});

test("any living body out in the world may be teleported, not only a player", async () => {
  const { made, host, cruiser, ask } = await teleporterCrew();
  placeStunTrap(host, { x: 50, y: 50 });
  const trap = [...host.entities.values()].find(
    (entity) => entity.kind === host.kindIds.get("stunTrap"),
  );
  if (trap === undefined) throw new Error("no stun trap");
  made.run(200);
  ask("b", { teleport: trap.id });
  made.run(config.seconds * 1000 + 200);
  expect(near(trap, cruiser, config.spread + 1)).toBe(true);
});
