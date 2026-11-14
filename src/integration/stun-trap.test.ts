import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { giveItem, usesAt } from "../sim/index.js";
import type { Controls, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

const GUEST = { x: 300, y: 300 };
const using: Controls = { ...idle, use: true };

const trapsIn = (game: Session): WorldEntity[] =>
  [...game.entities.values()].filter(
    (entity) => entity.kind === game.kindIds.get("stunTrap"),
  );

test("a guest puts its stun trap down where it stands, spending it, and the trap is seen everywhere", async () => {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 500 }, b: GUEST },
      content: [
        ...entityContent(testEntitiesConfig),
        ...itemContent(testItemsConfig),
      ],
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  expect(giveItem(host, "b", "stunTrap", 1)).toBe(true);
  guest.local.held = 1;
  made.run(300, { b: idle });

  made.step({ b: using });
  made.run(300, { b: idle });

  expect(usesAt(host, playerOn(made.room("a"), "b"), 1)).toBeNull();
  expect(guest.local.inventory[1]).toBeNull();
  for (const game of [host, guest]) {
    const [trap, ...more] = trapsIn(game);
    expect(more).toHaveLength(0);
    expect(trap).toBeDefined();
    expect(
      Math.hypot((trap?.x ?? 0) - GUEST.x, (trap?.y ?? 0) - GUEST.y),
    ).toBeLessThan(5);
  }
});
