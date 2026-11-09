import { describe, expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  applyEntitySnapshot,
  entitySnapshot,
  registerEntityType,
  spawnEntity,
} from "./entities.js";
import type { Session } from "./session.js";
import { createSession, updateSession } from "./session.js";

const DT = 1 / 60;
const KIND = 1;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };

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
    data: z.object({ steps: z.number().int() }),
    update(entity, data) {
      entity.vx = 60;
      return { steps: data.steps + 1 };
    },
    draw: () => undefined,
  });
  return game;
}

describe("spawning", () => {
  test("ids are the local id and a counter", () => {
    const game = session();
    expect(spawnEntity(game, KIND, 100, 100, { steps: 0 }).id).toBe("me:1");
    expect(spawnEntity(game, KIND, 100, 100, { steps: 0 }).id).toBe("me:2");
  });

  test("skips ids already taken, such as ones heard from a host", () => {
    const game = session();
    applyEntitySnapshot(game, [
      { id: "me:1", kind: KIND, x: 100, y: 300, data: { steps: 0 } },
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
      { id: "h:1", kind: KIND, x: 100, y: 300, data: { steps: 0 } },
    ]);
    applyEntitySnapshot(game, [
      { id: "h:1", kind: KIND, x: 200, y: 300, data: { steps: 5 } },
    ]);
    const entity = game.entities.get("h:1");
    updateSession(game, idle, DT);
    expect(entity?.x).toBeGreaterThan(100);
    expect(entity?.x).toBeLessThan(200);
    expect(entity?.data).toEqual({ steps: 5 });
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
      { id: "h:1", kind: KIND, x: 100, y: 300, data: { steps: 0 } },
      { id: "h:2", kind: KIND, x: 200, y: 300, data: { steps: 0 } },
    ]);
    spawnEntity(game, KIND, 300, 300, { steps: 0 });
    applyEntitySnapshot(game, [
      { id: "h:2", kind: KIND, x: 200, y: 300, data: { steps: 0 } },
    ]);
    expect([...game.entities.keys()]).toEqual(["h:2"]);
  });

  test.each([
    ["an unregistered kind", { kind: 9, x: 100, y: 300, data: { steps: 0 } }],
    ["data its kind rejects", { kind: KIND, x: 100, y: 300, data: {} }],
    [
      "a spot inside a wall",
      { kind: KIND, x: 250, y: 100, data: { steps: 0 } },
    ],
  ])("an entry with %s is left out", (_label, entry) => {
    const game = session();
    applyEntitySnapshot(game, [{ id: "h:1", ...entry }]);
    expect(game.entities.size).toBe(0);
  });
});
