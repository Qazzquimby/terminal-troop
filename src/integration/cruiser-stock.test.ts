import { expect, test, vi } from "vitest";
import { entityContent, sales } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  cabinGamble,
  cabinShop,
  cabinStorage,
  credit,
  giveItem,
  itemsOf,
  usesLeft,
} from "../sim/index.js";
import type { CabinCommand, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** No scrap on the ground, so interact never picks anything up. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const { cruiser: config } = testEntitiesConfig;
const PRICES = Object.fromEntries(
  config.shop.wares.map((ware) => [ware.item, ware.price]),
);

/** Clients a, hosting, and b, both inside the one cruiser. */
async function aboard() {
  const made = await crew(
    {
      spots: { a: { x: 430, y: 330 }, b: { x: 470, y: 330 } },
      content: [
        ...entityContent({
          ...testEntitiesConfig,
          zombie: {
            ...testEntitiesConfig.zombie,
            spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
          },
          cruiser: { ...config, length: 80, width: 48 },
        }),
        ...itemContent(items),
      ],
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const kind = host.kindIds.get("cruiser");
  const cruiser = [...host.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (cruiser === undefined) throw new Error("no cruiser");
  Object.assign(cruiser, { x: 450, y: 300, prevX: 450, prevY: 300 });
  made.run(500);
  made.step({
    a: { ...idle, interact: true },
    b: { ...idle, interact: true },
  });
  made.run(500);
  const game = (id: string): Session => sessionOf(made.room(id));
  for (const id of ["a", "b"])
    expect(game(id).local.ride?.vehicle).toBe(cruiser.id);
  /** `id` asks `command` of the cabin, and the room settles. */
  const ask = (id: string, command: CabinCommand): void => {
    made.step({ [id]: { ...idle, cabin: command } });
    made.run(600);
  };
  /** The storage as client `id` has it: each item's id and uses left. */
  const stored = (id: string, vehicle: WorldEntity = cruiser) =>
    (cabinStorage(game(id), vehicle.id) ?? []).map((item) =>
      item === null ? null : { id: item.id, left: usesLeft(item) },
    );
  /** Client `id`'s own items, as its client has them. */
  const pockets = (id: string) =>
    game(id).local.inventory.map((item) => item?.id ?? null);
  return { ...made, host, cruiser, game, ask, stored, pockets };
}

test("an item stowed keeps its uses and state, every occupant sees it, and another takes it out so", async () => {
  const { host, game, ask, stored, pockets } = await aboard();
  expect(giveItem(host, "b", "flashlight", 1, 4, { mark: 3 })).toBe(true);
  ask("b", { stow: 1 });

  expect(pockets("b")[1]).toBeNull();
  for (const id of ["a", "b"])
    expect([id, stored(id)]).toEqual([
      id,
      [{ id: "flashlight", left: 4 }, null, null, null, null, null],
    ]);

  // Into a chosen empty slot; a taken one refuses.
  expect(giveItem(host, "b", "walkie", 2)).toBe(true);
  ask("b", { stow: 2, into: 0 });
  expect(pockets("b")[2]).toBe("walkie");
  ask("b", { stow: 2, into: 4 });
  expect(stored("a")[4]?.id).toBe("walkie");

  ask("a", { unstow: 0 });
  const taken = itemsOf(host, "a").find((item) => item?.id === "flashlight");
  expect(taken).toMatchObject({ left: 4, state: { mark: 3 } });
  expect(game("a").local.inventory).toContainEqual(
    expect.objectContaining({ id: "flashlight", left: 4 }),
  );
  for (const id of ["a", "b"]) expect([id, stored(id)[0]]).toEqual([id, null]);
});

test("taking from the storage needs room in the taker's items", async () => {
  const { host, ask, stored, pockets } = await aboard();
  expect(giveItem(host, "b", "walkie", 1)).toBe(true);
  ask("b", { stow: 1 });
  const full = pockets("a").length;
  for (let slot = 0; slot < full; slot++) giveItem(host, "a", "shovel", slot);
  ask("a", { unstow: 0 });
  expect(stored("a")[0]?.id).toBe("walkie");
  expect(pockets("a")).not.toContain("walkie");
});

test("buying takes the price from the team's credit on every client and gives the buyer the item", async () => {
  const { host, game, ask, pockets } = await aboard();
  const start = (PRICES.walkie ?? 0) + (PRICES.shovel ?? 0);
  credit.set(host, start);
  ask("b", { buy: "walkie" });
  ask("b", { buy: "shovel" });
  for (const id of ["a", "b"])
    expect([id, credit.get(game(id))]).toEqual([id, 0]);
  expect(pockets("b")).toContain("walkie");
  expect(pockets("b")).toContain("shovel");

  // With nothing left, nothing is bought, and the buyer's client takes the host's word.
  ask("b", { buy: "walkie" });
  expect(pockets("b").filter((item) => item === "walkie")).toHaveLength(1);
  expect(credit.get(host)).toBe(0);
  const shop = cabinShop(game("b"), game("b").local.ride?.vehicle ?? "");
  expect(shop).toEqual({
    wares: config.shop.wares.map((ware) => ({
      ...ware,
      was: ware.price,
      off: 0,
    })),
    credit: 0,
  });
});

test("a ware on sale shows and sells at its sale price on every client", async () => {
  const { host, game, ask, pockets } = await aboard();
  sales.set(host, { drawn: host.worldTime, off: { flashlight: 50 } });
  credit.set(host, 2);
  ask("b", { buy: "walkie" });
  for (const id of ["a", "b"]) {
    const shop = cabinShop(game(id), game(id).local.ride?.vehicle ?? "");
    expect(shop?.wares.find((ware) => ware.item === "flashlight")).toEqual({
      item: "flashlight",
      price: 1,
      was: 3,
      off: 50,
    });
  }
  // The walkie, at its full 2, took everything; the flashlight, at half price, is out of reach.
  expect(credit.get(host)).toBe(0);
  credit.set(host, 1);
  ask("b", { buy: "flashlight" });
  expect(pockets("b")).toContain("flashlight");
  expect(credit.get(game("a"))).toBe(0);
});

test("a coin toss stakes the bet from the team's credit, and the host pays a win back double", async () => {
  const { host, game, ask, run, step } = await aboard();
  const vehicle = (id: string) => game(id).local.ride?.vehicle ?? "";
  credit.set(host, 10);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
  try {
    step({ b: { ...idle, cabin: { toss: 4 } } });
    run(200);
    for (const id of ["a", "b"]) {
      expect([id, credit.get(game(id))]).toEqual([id, 6]);
      expect(cabinGamble(game(id), vehicle(id))?.tossing).toEqual({
        by: game("b").local.name,
        bet: 4,
      });
    }
    // Another coin may not go up while this one is.
    step({ a: { ...idle, cabin: { toss: 1 } } });
    run(200);
    expect(credit.get(host)).toBe(6);
    run(config.coinToss.flight * 1000);
    for (const id of ["a", "b"]) {
      expect([id, credit.get(game(id))]).toEqual([id, 14]);
      expect(cabinGamble(game(id), vehicle(id))).toEqual({
        tossing: null,
        last: { by: game("b").local.name, bet: 4, n: 1, won: true },
      });
    }

    random.mockReturnValue(0.9);
    ask("a", { toss: 14 });
    run(config.coinToss.flight * 1000);
    expect(credit.get(game("b"))).toBe(0);
    expect(cabinGamble(game("b"), vehicle("b"))?.last).toMatchObject({
      n: 2,
      won: false,
    });

    // With nothing banked, nothing is staked.
    ask("a", { toss: 1 });
    expect(cabinGamble(host, vehicle("a"))?.tossing).toBeNull();
  } finally {
    random.mockRestore();
  }
});

test("a buyer whose items are full gets what it bought in the storage; with both full it is not bought", async () => {
  const { host, ask, stored, pockets } = await aboard();
  const full = pockets("b").length;
  for (let slot = 0; slot < full; slot++) giveItem(host, "b", "shovel", slot);
  credit.set(host, 100);
  ask("b", { buy: "flashlight" });
  expect(stored("b")[0]).toEqual({ id: "flashlight", left: 10 });
  expect(credit.get(host)).toBe(100 - (PRICES.flashlight ?? 0));

  for (let bought = 1; bought < config.storage.slots; bought++)
    ask("b", { buy: "walkie" });
  expect(stored("a").every((item) => item !== null)).toBe(true);
  const before = credit.get(host);
  ask("b", { buy: "walkie" });
  expect(credit.get(host)).toBe(before);
});
