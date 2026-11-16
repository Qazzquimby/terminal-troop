import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { giveItem } from "../sim/index.js";
import type { Controls, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** The guest, left of the dev square's middle row, which runs clear from end to end. */
const GUEST = { x: 150, y: 300 };
/** Aiming right along that row. */
const aimRight = { x: 800, y: 300 };
/**
 * Sends 8 to 11 cells, so a send along the row lands within the square, but always further than a
 * body runs between snapshots.
 */
const entities = {
  ...testEntitiesConfig,
  teleporter: {
    ...testEntitiesConfig.teleporter,
    distance: { min: 400, max: 560 },
  },
};

const padsIn = (game: Session): WorldEntity[] =>
  [...game.entities.values()].filter(
    (entity) => entity.kind === game.kindIds.get("teleporter"),
  );

test("a guest lays a teleporter ahead of it, steps on it and is placed far off at once, on every client", async () => {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 560 }, b: GUEST, c: { x: 750, y: 40 } },
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
    },
    "a",
    "b",
    "c",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  const watcher = sessionOf(made.room("c"));
  expect(giveItem(host, "b", "teleporter", 1)).toBe(true);
  guest.local.held = 1;
  const aiming: Controls = { ...idle, aim: aimRight };
  made.run(300, { b: aiming });

  made.step({ b: { ...aiming, use: true } });
  made.run(300, { b: aiming });
  for (const game of [host, guest, watcher]) {
    const [pad, ...more] = padsIn(game);
    expect(more).toHaveLength(0);
    // Ahead of the guest, the way it aimed.
    expect(pad?.x).toBeGreaterThan(GUEST.x + 20);
    expect(pad?.y).toBeCloseTo(GUEST.y, 0);
  }
  made.run(entities.teleporter.armSeconds * 1000, { b: aiming });

  // The guest walks onto it, stopping once the host has sent it off, and the watcher never sees it
  // anywhere between the pad and where it lands.
  const walk: Controls = { ...aiming, move: { x: 1, y: 0 } };
  const sent = () => playerOn(made.room("a"), "b").x > GUEST.x + 200;
  const seen: number[] = [];
  for (let step = 0; step < 90; step++) {
    made.step({ b: sent() ? aiming : walk });
    seen.push(playerOn(made.room("c"), "b").x);
  }
  const landed = playerOn(made.room("a"), "b").x;
  expect(landed).toBeGreaterThan(GUEST.x + 250);
  expect(Math.abs(guest.local.x - landed)).toBeLessThan(5);
  expect(Math.abs(playerOn(made.room("c"), "b").x - landed)).toBeLessThan(5);
  expect(seen.filter((x) => x > GUEST.x + 100 && x < landed - 20)).toEqual([]);
});
