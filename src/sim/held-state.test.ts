import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyEntitySnapshot,
  applyWorldEntries,
  createSession,
  ITEM_TAG,
  registerContent,
  registerEntityType,
  spawnEntity,
  worldData,
} from "./index.js";
import { kindTags } from "./noise.js";
import type { Session } from "./session.js";

/*
 * Held state is parsed once for each value held, not on every read (#470); each write path must
 * still be read back as written.
 */

function session(): Session {
  return createSession("me", "ME", "WORLD", "dev", testSfx(), testSimConfig);
}

const hostA = { host: "a", term: 1 };

function withTally(game: Session) {
  const tally = worldData({
    schema: z.record(z.string(), z.number()),
    initial: {},
  });
  registerContent(game, [
    {
      name: "entity/tally",
      world: { tally },
      register: () => undefined,
      populate: () => undefined,
    },
  ]);
  return tally;
}

test("the host reads each value it sets, and the same value until it sets another", () => {
  const game = session();
  const tally = withTally(game);
  tally.set(game, { a: 1 });
  const first = tally.get(game);
  expect(first).toEqual({ a: 1 });
  expect(tally.get(game)).toBe(first);
  tally.set(game, { a: 2 });
  expect(tally.get(game)).toEqual({ a: 2 });
});

test("a guest reads each value the host sends as it arrives", () => {
  const game = session();
  game.hosting = false;
  const tally = withTally(game);
  applyWorldEntries(game, hostA, { "entity/tally.tally": [1, { a: 1 }] });
  expect(tally.get(game)).toEqual({ a: 1 });
  applyWorldEntries(game, hostA, { "entity/tally.tally": [2, { a: 2 }] });
  expect(tally.get(game)).toEqual({ a: 2 });
  applyWorldEntries(
    game,
    { host: "b", term: 2 },
    {
      "entity/tally.tally": [1, { b: 3 }],
    },
  );
  expect(tally.get(game)).toEqual({ b: 3 });
});

test("a value read is frozen under test, so content that changes it in place fails", () => {
  const game = session();
  const tally = withTally(game);
  tally.set(game, { a: 1 });
  expect(Object.isFrozen(tally.get(game))).toBe(true);
});

/** A kind whose perceiver is the name its state holds, so a test can read the state as parsed. */
function withNamed(game: Session) {
  registerEntityType(game, "named", {
    radius: 5,
    maxHealth: 1,
    data: z.object({ name: z.string() }),
    perceivedBy: (_entity, data) => data.name,
    draw: () => undefined,
  });
}

test("a kind's hooks read each state an entity takes, on the host", () => {
  const game = session();
  withNamed(game);
  const entity = spawnEntity(game, "named", 100, 300, { name: "ana" });
  const type = game.entityTypes.get(entity.kind);
  expect(type?.perceiver(entity)).toBe("ana");
  entity.data = { name: "bo" };
  expect(type?.perceiver(entity)).toBe("bo");
});

test("a kind's hooks read each state a host sends, on a guest", () => {
  const game = session();
  game.hosting = false;
  withNamed(game);
  const kind = game.kindIds.get("named") ?? 0;
  const sent = (name: string) => [
    { id: "z", kind, x: 100, y: 300, health: 1, data: { name } },
  ];
  const type = game.entityTypes.get(kind);
  const perceiver = () => {
    const entity = game.entities.get("z");
    return entity === undefined ? undefined : type?.perceiver(entity);
  };
  applyEntitySnapshot(game, sent("ana"));
  expect(perceiver()).toBe("ana");
  applyEntitySnapshot(game, sent("bo"));
  expect(perceiver()).toBe("bo");
});

test("a kind's tags follow kinds registered later, and its pose as an item", () => {
  const game = session();
  registerEntityType(game, "rock", {
    radius: 5,
    maxHealth: 1,
    tags: ["hard"],
    data: z.object({ posing: z.boolean() }),
    posesAsItem: (_entity, data) => (data.posing ? { item: "pebble" } : null),
    draw: () => undefined,
  });
  const rock = spawnEntity(game, "rock", 100, 300, { posing: false });
  expect(kindTags(game, rock.id)).toEqual(["rock", "hard"]);
  rock.data = { posing: true };
  expect(kindTags(game, rock.id)).toEqual(["rock", "hard", ITEM_TAG]);

  registerEntityType(game, "moss", {
    radius: 5,
    maxHealth: 1,
    tags: ["soft"],
    data: z.null(),
    draw: () => undefined,
  });
  const moss = spawnEntity(game, "moss", 100, 300, null);
  expect(kindTags(game, moss.id)).toEqual(["moss", "soft"]);
});
