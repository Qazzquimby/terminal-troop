import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { giveItem } from "../sim/index.js";
import type { Controls, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** No zombies, so nothing but the players stands in a flare's way or a bomb's. */
const entities = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

const ofKind = (game: Session, kind: string): WorldEntity[] =>
  [...game.entities.values()].filter(
    (entity) => entity.kind === game.kindIds.get(kind),
  );

const aimRight = { x: 800, y: 300 };

test("a guest shoots its flare gun's three flares, which burn on every client, and the gun is spent", async () => {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 560 }, b: { x: 150, y: 300 } },
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  expect(giveItem(host, "b", "flareGun", 1)).toBe(true);
  guest.local.held = 1;
  const aiming: Controls = { ...idle, aim: aimRight };
  made.run(300, { b: aiming });
  for (let shot = 0; shot < 3; shot++) {
    made.step({ b: { ...aiming, use: true } });
    made.run(1100, { b: aiming });
  }
  for (const game of [host, guest])
    expect(ofKind(game, "flare")).toHaveLength(3);
  expect(guest.local.inventory.some((item) => item?.id === "flareGun")).toBe(
    false,
  );
});

test("a guest lays a bomb in the middle of its cell, and its burst knocks the pillar above down on every client", async () => {
  // In the cell at column 4, row 6, under the pillar at columns 4-5, rows 1-2.
  const made = await crew(
    {
      spots: { a: { x: 750, y: 560 }, b: { x: 215, y: 330 } },
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  expect(giveItem(host, "b", "bomb", 1)).toBe(true);
  guest.local.held = 1;
  made.run(300, { b: idle });
  made.step({ b: { ...idle, use: true } });
  made.run(300, { b: idle });
  for (const game of [host, guest]) {
    const [laid, ...more] = ofKind(game, "bomb");
    expect(more).toHaveLength(0);
    expect(laid).toMatchObject({ x: 225, y: 325 });
  }
  // The guest runs out of the burst's way, down and left, off its column and its row.
  made.run(1500, { b: { ...idle, move: { x: -1, y: 1 } } });
  made.run(entities.bomb.fuse * 1000, { b: idle });
  for (const game of [host, guest]) {
    const { solid, cols } = game.world.map;
    expect(ofKind(game, "bomb")).toHaveLength(0);
    expect(solid[2 * cols + 4]).toBe(0);
    expect(solid[1 * cols + 4]).toBe(0);
    expect(solid[1 * cols + 5]).toBe(1);
  }
});
