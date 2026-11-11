import { describe, expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyEntitySnapshot,
  entitySnapshot,
  registerEntityType,
  spawnEntity,
} from "./entities.js";
import { applyDamage } from "./entity.js";
import type { Session } from "./session.js";
import { createSession, updateSession } from "./session.js";

const DT = 1 / 60;
const KIND = "walker";
/** The number the walker is sent as: it is the first kind registered. */
const KIND_ID = 1;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
};

/** A dev-square session whose one kind counts its updates and drifts right at 60px/s. */
function session(localId = "me"): Session {
  const game = createSession(
    localId,
    "ME",
    "SYNC",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerEntityType(game, KIND, {
    radius: 10,
    maxHealth: 10,
    data: z.object({ steps: z.number().int() }),
    update(entity, data) {
      entity.vx = 60;
      return { steps: data.steps + 1 };
    },
    draw: () => undefined,
  });
  return game;
}

describe("registering", () => {
  const still = {
    radius: 5,
    maxHealth: 1,
    data: z.null(),
    draw: () => undefined,
  };

  test("numbers kinds by the order they are registered in, from 1", () => {
    const game = session();
    registerEntityType(game, "rock", still);
    registerEntityType(game, "tree", still);
    expect([...game.kindIds]).toEqual([
      [KIND, KIND_ID],
      ["rock", 2],
      ["tree", 3],
    ]);
    expect(spawnEntity(game, "tree", 100, 100, null).kind).toBe(3);
  });

  test("a name registered twice throws", () => {
    expect(() => {
      registerEntityType(session(), KIND, still);
    }).toThrow(/already registered/);
  });

  test.each([0, -5, Number.NaN])(
    "a kind with %d health throws",
    (maxHealth) => {
      expect(() => {
        registerEntityType(session(), "rock", { ...still, maxHealth });
      }).toThrow(/positive/);
    },
  );

  test("an unbreakable kind takes damage and stays whole", () => {
    const game = session();
    registerEntityType(game, "rock", { ...still, maxHealth: Infinity });
    const rock = spawnEntity(game, "rock", 100, 300, null);
    applyDamage(rock, 1_000_000);
    updateSession(game, idle, DT);
    expect(rock.health).toBe(Infinity);
    expect(game.entities.has(rock.id)).toBe(true);
  });

  test("spawning a name never registered throws", () => {
    expect(() => spawnEntity(session(), "rock", 100, 100, null)).toThrow(
      /Unregistered/,
    );
  });
});

describe("spawning", () => {
  test("ids are the local id and a counter", () => {
    const game = session();
    expect(spawnEntity(game, KIND, 100, 100, { steps: 0 }).id).toBe("me:1");
    expect(spawnEntity(game, KIND, 100, 100, { steps: 0 }).id).toBe("me:2");
  });

  test("skips ids already taken, such as ones heard from a host", () => {
    const game = session();
    applyEntitySnapshot(game, [
      {
        id: "me:1",
        kind: KIND_ID,
        x: 100,
        y: 300,
        health: 10,
        data: { steps: 0 },
      },
    ]);
    expect(spawnEntity(game, KIND, 100, 100, { steps: 0 }).id).toBe("me:2");
  });

  test("throws on data the kind rejects", () => {
    expect(() =>
      spawnEntity(session(), KIND, 100, 100, { steps: "many" }),
    ).toThrow();
  });
});

describe("hosting", () => {
  test("a hosting session runs its entities, their targets following them", () => {
    const game = session();
    const entity = spawnEntity(game, KIND, 100, 300, { steps: 0 });
    updateSession(game, idle, DT);
    expect(entity).toMatchObject({ x: 101, tx: 101, data: { steps: 1 } });
  });

  test("a session that does not host eases its entities towards their snapshot", () => {
    const game = session();
    game.hosting = false;
    applyEntitySnapshot(game, [
      {
        id: "h:1",
        kind: KIND_ID,
        x: 100,
        y: 300,
        health: 10,
        data: { steps: 0 },
      },
    ]);
    applyEntitySnapshot(game, [
      {
        id: "h:1",
        kind: KIND_ID,
        x: 200,
        y: 300,
        health: 10,
        data: { steps: 5 },
      },
    ]);
    const entity = game.entities.get("h:1");
    updateSession(game, idle, DT);
    expect(entity?.x).toBeGreaterThan(100);
    expect(entity?.x).toBeLessThan(200);
    expect(entity?.data).toEqual({ steps: 5 });
  });

  test("a hosting session removes entities whose health has run out, before running them", () => {
    const game = session();
    const dead = spawnEntity(game, KIND, 100, 300, { steps: 0 });
    const alive = spawnEntity(game, KIND, 400, 300, { steps: 0 });
    applyDamage(dead, 10);
    applyDamage(alive, 9);
    updateSession(game, idle, DT);
    expect([...game.entities.keys()]).toEqual([alive.id]);
    expect(dead.data).toEqual({ steps: 0 });
  });

  test("a session that does not host keeps a dead entity until the host's snapshot drops it", () => {
    const game = session();
    game.hosting = false;
    const entry = {
      id: "h:1",
      kind: KIND_ID,
      x: 100,
      y: 300,
      data: { steps: 0 },
    };
    applyEntitySnapshot(game, [{ ...entry, health: 0 }]);
    updateSession(game, idle, DT);
    expect([...game.entities.keys()]).toEqual(["h:1"]);
    applyEntitySnapshot(game, []);
    expect([...game.entities.keys()]).toEqual([]);
  });
});

describe("damage", () => {
  test("takes health down to zero and no further, and says how much it took", () => {
    const game = session();
    const entity = spawnEntity(game, KIND, 100, 300, { steps: 0 });
    expect(applyDamage(entity, 4)).toBe(4);
    expect(applyDamage(entity, -3)).toBe(0);
    expect(applyDamage(entity, 50)).toBe(6);
    expect(entity.health).toBe(0);
  });

  test("a strike on the local player lands at once, and one on a player not in the session is dropped", () => {
    const game = session();
    registerEntityType(game, "striker", {
      radius: 10,
      maxHealth: 10,
      data: z.object({}),
      update: (_entity, data) => data,
      strikes: () => [
        { target: "me", amount: 150 },
        { target: "ghost", amount: 5 },
      ],
      draw: () => undefined,
    });
    spawnEntity(game, "striker", 100, 300, {});
    updateSession(game, idle, DT);
    expect(game.local.health).toBe(0);
    expect(game.outbox).toEqual([]);
  });
});

describe("snapshots", () => {
  test("a snapshot rebuilds the host's entities, ids and state included", () => {
    const host = session("host");
    spawnEntity(host, KIND, 100, 300, { steps: 0 });
    spawnEntity(host, KIND, 400, 300, { steps: 0 });
    updateSession(host, idle, DT);

    const other = session("other");
    applyEntitySnapshot(other, entitySnapshot(host));
    expect(entitySnapshot(other)).toEqual(entitySnapshot(host));
  });

  test("entities missing from a snapshot are removed", () => {
    const game = session();
    applyEntitySnapshot(game, [
      {
        id: "h:1",
        kind: KIND_ID,
        x: 100,
        y: 300,
        health: 10,
        data: { steps: 0 },
      },
      {
        id: "h:2",
        kind: KIND_ID,
        x: 200,
        y: 300,
        health: 10,
        data: { steps: 0 },
      },
    ]);
    spawnEntity(game, KIND, 300, 300, { steps: 0 });
    applyEntitySnapshot(game, [
      {
        id: "h:2",
        kind: KIND_ID,
        x: 200,
        y: 300,
        health: 10,
        data: { steps: 0 },
      },
    ]);
    expect([...game.entities.keys()]).toEqual(["h:2"]);
  });

  test.each([
    [
      "an unregistered kind",
      { kind: 9, x: 100, y: 300, health: 10, data: { steps: 0 } },
    ],
    [
      "data its kind rejects",
      { kind: KIND_ID, x: 100, y: 300, health: 10, data: {} },
    ],
    [
      "a spot inside a wall",
      { kind: KIND_ID, x: 250, y: 100, health: 10, data: { steps: 0 } },
    ],
  ])("an entry with %s is left out", (_label, entry) => {
    const game = session();
    applyEntitySnapshot(game, [{ id: "h:1", ...entry }]);
    expect(game.entities.size).toBe(0);
  });
});
