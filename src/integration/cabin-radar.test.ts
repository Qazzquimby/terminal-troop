import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import {
  CORPSE_ITEM,
  hasKindTag,
  hurtPlayer,
  ITEM_TAG,
  itemInstances,
  removeFromWorld,
} from "../sim/index.js";
import type { Point, Session, WorldEntity } from "../sim/index.js";
import { minimapCentre, minimapTargets, radarBlips } from "../ui/index.js";
import { crew, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** Host a and guest b, one zombie, and whatever scrap the test config scatters. */
const radarCrew = () =>
  crew(
    {
      spots: { a: { x: 400, y: 360 }, b: { x: 700, y: 560 } },
      content: [
        ...entityContent({
          ...testEntitiesConfig,
          zombie: {
            ...testEntitiesConfig.zombie,
            spawn: { ...testEntitiesConfig.zombie.spawn, count: 1 },
          },
        }),
        ...itemContent(testItemsConfig),
      ],
    },
    "a",
    "b",
  );

function kindOf(game: Session, name: string): WorldEntity {
  const kind = game.kindIds.get(name);
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

const has = (points: readonly Point[], at: Point): boolean =>
  points.some((point) => point.x === at.x && point.y === at.y);

test("the radar shows items as items and every living body, player or monster, as living", async () => {
  const made = await radarCrew();
  const game = sessionOf(made.room("a"));
  const zombie = kindOf(game, "zombie");
  const cruiser = kindOf(game, "cruiser");
  const b = playerOn(made.room("a"), "b");
  const blips = radarBlips(game, "a");
  expect(has(blips.living, zombie)).toBe(true);
  expect(has(blips.living, b)).toBe(true);
  // The one it follows is marked apart; the car itself is inert.
  expect(has(blips.living, game.local)).toBe(false);
  expect(has(blips.living, cruiser)).toBe(false);
  expect(has(blips.items, cruiser)).toBe(false);
  const lying = [...game.entities.values()].filter((entity) =>
    hasKindTag(game, entity.id, [ITEM_TAG]),
  );
  expect(blips.items).toHaveLength(lying.length);
  for (const item of lying) {
    expect(has(blips.items, item)).toBe(true);
    expect(has(blips.living, item)).toBe(false);
  }
});

test("a dead player is followed last, centred on its corpse, or where it fell once the corpse is gone", async () => {
  const made = await radarCrew();
  const host = sessionOf(made.room("a"));
  const b = playerOn(made.room("a"), "b");
  hurtPlayer(host, b, b.maxHealth);
  made.run(500);
  for (const id of ["a", "b"]) {
    const game = sessionOf(made.room(id));
    expect(minimapTargets(game).at(-1)).toBe("b");
  }
  const game = sessionOf(made.room("a"));
  const corpse = itemInstances(host, CORPSE_ITEM)[0];
  if (corpse === undefined || !("lying" in corpse.place))
    throw new Error("no corpse");
  expect(minimapCentre(game, b)).toEqual({ at: corpse.at, corpse: true });
  // The dead are not picked up as living.
  expect(has(radarBlips(game, "a").living, b)).toBe(false);

  removeFromWorld(host, corpse.place.lying);
  made.run(300);
  expect(minimapCentre(game, b)).toEqual({
    at: { x: b.x, y: b.y },
    corpse: false,
  });
});
