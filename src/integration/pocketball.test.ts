import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent, pocketOf } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { giveItem, glyphOf, pocketAt } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** No zombies, so nothing but the players gets in the ball's way. */
const entities = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

/** Along the dev square's middle row, which runs clear from end to end. */
const THROWER = { x: 150, y: 300 };
const TARGET = { x: 260, y: 300 };
const HOST = { x: 420, y: 300 };
const aimRight = { x: 800, y: 300 };

/** The slot `game`'s own player carries a pocketball in; -1 for none. */
const ballSlot = (game: Session): number =>
  game.local.inventory.findIndex((item) => item?.id === "pocketball");

/** A lying item's state, as far as this test reads it. */
const Lying = z.object({
  item: z.string(),
  state: z.record(z.string(), z.number()).optional(),
});

/** The pocketballs lying about on `game`, with the pocket each holds and how each is drawn. */
const lyingBalls = (game: Session) =>
  [...game.entities.values()].flatMap((entity) => {
    const data = Lying.safeParse(entity.data).data;
    if (data?.item !== "pocketball") return [];
    const definition = game.itemDefinitions.get("pocketball");
    return [
      {
        pocket: pocketOf(data.state),
        glyph: definition === undefined ? "" : glyphOf(definition, data.state),
      },
    ];
  });

test("a guest's ball catches another player, whom a third picks up, carries and lets out, on every client", async () => {
  const made = await crew(
    {
      spots: { a: HOST, b: THROWER, c: TARGET },
      content: [...entityContent(entities), ...itemContent(testItemsConfig)],
    },
    "a",
    "b",
    "c",
  );
  const host = sessionOf(made.room("a"));
  const thrower = sessionOf(made.room("b"));
  const caught = sessionOf(made.room("c"));
  const all = [host, thrower, caught];
  expect(giveItem(host, "b", "pocketball", 1)).toBe(true);
  thrower.local.held = 1;
  const aiming: Controls = { ...idle, aim: aimRight };
  made.run(300, { b: aiming });

  made.step({ b: { ...aiming, use: true } });
  made.run(600, { b: aiming });
  expect(ballSlot(thrower)).toBe(-1);
  for (const game of all) {
    const pocket = pocketAt(game.world.map, playerOn(made.room("a"), "c"));
    expect(pocket).not.toBeNull();
    expect(pocketAt(game.world.map, game.players.get("c") ?? game.local)).toBe(
      pocket,
    );
    // The ball lies full where it struck, drawn as full.
    const [ball, ...more] = lyingBalls(game);
    expect(more).toHaveLength(0);
    expect(ball?.pocket).toBe(pocket);
    expect(ball?.glyph).toBe("🔴");
  }
  // The caught player is in the pocket on its own client too.
  expect(pocketAt(caught.world.map, caught.local)).not.toBeNull();

  // The host walks to the ball and picks it up, the pocket coming with it.
  const walk: Controls = { ...idle, move: { x: -1, y: 0 }, interact: true };
  for (let step = 0; step < 240 && ballSlot(host) < 0; step++)
    made.step({ a: walk });
  made.run(300);
  const slot = ballSlot(host);
  expect(slot).toBeGreaterThanOrEqual(0);
  expect(pocketOf(host.local.inventory[slot]?.state)).not.toBeNull();
  for (const game of all) expect(lyingBalls(game)).toHaveLength(0);

  // Thrown again, it lets the caught player out where it lands, and is spent.
  host.local.held = slot;
  const from = host.local.x;
  made.run(300, { a: aiming });
  made.step({ a: { ...aiming, use: true } });
  made.run(1000, { a: aiming });
  for (const game of all) {
    const out = game.players.get("c") ?? game.local;
    expect(pocketAt(game.world.map, out)).toBeNull();
    expect(out.x).toBeGreaterThan(from + testItemsConfig.pocketball.range / 2);
    expect(lyingBalls(game)).toHaveLength(0);
  }
  expect(ballSlot(host)).toBe(-1);
});
