import { expect, test } from "vitest";
import { entityContent, requestSpawn } from "../entities/index.js";
import type { SpawnChoice } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, sessionOf } from "./crew.js";
import { forgeAction } from "./room-helpers.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSimConfig,
} from "./sim-config.js";

const SPAWN = "entity/debug-spawn.spawn";
const { cell } = testSimConfig.world;
const DISTANCE = testEntitiesConfig.debugSpawn.cells * cell;
/** The guest's spot: clear of the dev square's pillars for 10 cells to its right. */
const GUEST = { x: 75, y: 300 };
/** A spot with the dev square's first pillar, from x 200, 2 cells to its right. */
const BY_PILLAR = { x: 100, y: 100 };

const ZOMBIE: SpawnChoice = { what: "monster", kind: "zombie", label: "" };
const SHOVEL: SpawnChoice = { what: "item", kind: "shovel", label: "" };

/** Facing right of `at`. */
const facingRight = (at: Point): Controls => ({
  ...idle,
  aim: { x: at.x + 1000, y: at.y },
});

/** `a` hosting and `b` its guest, with every entity and item; `enabled` says if the host takes debug spawns. */
async function crewOf(enabled = true) {
  const room = await crew(
    {
      spots: { a: { x: 450, y: 450 }, b: GUEST },
      content: [
        ...entityContent({
          ...testEntitiesConfig,
          debugSpawn: { ...testEntitiesConfig.debugSpawn, enabled },
        }),
        ...itemContent(testItemsConfig),
      ],
    },
    "a",
    "b",
  );
  const host = sessionOf(room.room("a"));
  const guest = sessionOf(room.room("b"));
  /** The flashes each client showed while `spawned` stepped, by client id. */
  const flashes: Record<"a" | "b", Session["flashes"][number][]> = {
    a: [],
    b: [],
  };
  /**
   * Steps half a second, the guest facing right of where it stands, and returns the first entity
   * the host came to hold that it did not before, as it first held it; null for none.
   */
  const spawned = (): WorldEntity | null => {
    const before = new Set(host.entities.keys());
    let found: WorldEntity | null = null;
    for (let step = 0; step < 30; step++) {
      room.step({ b: facingRight(guest.local) });
      flashes.a.push(...host.flashes);
      flashes.b.push(...guest.flashes);
      for (const [id, entity] of host.entities)
        if (found === null && !before.has(id)) found = { ...entity };
    }
    return found;
  };
  return { ...room, host, guest, spawned, flashes };
}

const kindOf = (game: Session, entity: WorldEntity): string | undefined =>
  [...game.kindIds].find(([, id]) => id === entity.kind)?.[0];

test("a guest's spawn request brings the monster 10 cells ahead of it on the host", async () => {
  const { host, guest, spawned } = await crewOf();
  requestSpawn(guest, ZOMBIE);
  const zombie = spawned();
  expect(zombie).not.toBeNull();
  if (zombie === null) return;
  expect(kindOf(host, zombie)).toBe("zombie");
  const from = host.players.get("b");
  expect(zombie.x - (from?.x ?? 0)).toBeCloseTo(DISTANCE, -1);
  expect(zombie.y).toBeCloseTo(from?.y ?? 0, -1);
});

test("a guest's spawn request lays the item ahead of it, and both clients flash where it lands", async () => {
  const { host, guest, spawned, flashes } = await crewOf();
  requestSpawn(guest, SHOVEL);
  const shovel = spawned();
  expect(shovel).not.toBeNull();
  if (shovel === null) return;
  expect(kindOf(host, shovel)).toBe("core/world-item");
  expect(shovel.data).toMatchObject({ item: "shovel" });
  expect(shovel.x - (host.players.get("b")?.x ?? 0)).toBeCloseTo(DISTANCE, -1);
  for (const seen of [flashes.a, flashes.b]) {
    const flash = seen.find(
      ({ at }) => Math.hypot(at.x - shovel.x, at.y - shovel.y) < 1,
    );
    expect(flash?.hit).toBe(true);
  }
});

test("a wall in the way stops the spawn short of it", async () => {
  const { place, guest, host, spawned } = await crewOf();
  place("b", BY_PILLAR);
  requestSpawn(guest, ZOMBIE);
  const zombie = spawned();
  expect(zombie).not.toBeNull();
  if (zombie === null) return;
  const radius = testEntitiesConfig.zombie.radius;
  expect(zombie.x).toBeLessThanOrEqual(200 - radius);
  expect(zombie.x).toBeGreaterThan(host.players.get("b")?.x ?? 0);
});

test("a host that does not take debug spawns refuses them", async () => {
  const { guest, spawned } = await crewOf(false);
  requestSpawn(guest, ZOMBIE);
  expect(spawned()).toBeNull();
});

test("the host refuses a spawn of a kind the spawner does not bring, or no item", async () => {
  const { guest, spawned } = await crewOf();
  forgeAction(guest, SPAWN, { what: "monster", kind: "cruiser", aim: 0 });
  forgeAction(guest, SPAWN, { what: "item", kind: "nothing", aim: 0 });
  expect(spawned()).toBeNull();
});
