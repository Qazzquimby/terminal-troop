import { expect, test } from "vitest";
import { z } from "zod";
import { idle } from "../integration/crew.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { defineAction, hurt } from "./actions.js";
import { bodyById, isGone, livingBodies } from "./bodies.js";
import { receiveEvent } from "./content-event.js";
import { registerContent } from "./content.js";
import type { WorldContent } from "./content.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import type { Strike } from "./entities.js";
import { setPlayerHealth } from "./health.js";
import { hurtSinceLastStep, lastHurt, lastHurtBy, lastHurts } from "./hurts.js";
import { hasKindTag, PLAYER_TAG } from "./noise.js";
import { createPlayer } from "./player.js";
import type { Session } from "./session.js";
import { createSession, removePlayer, updateSession } from "./session.js";
import { shoot } from "./shot.js";
import { stun } from "./status.js";
import { applyWorldEntries, takeWorldEntries } from "./world-data.js";

const DT = 1 / 60;
const Target = z.object({ target: z.string() });

/** Hurts the named body by 5. */
const poke = defineAction("poke", {
  input: Target,
  apply(game, actor, { target }) {
    const body = bodyById(game, target);
    if (body !== null) hurt(game, body, 5, actor.id);
  },
});

/** What each biter strikes this step, and whose doing each strike is, by the biter's id. */
const bites = new Map<string, Strike[]>();

/** What each post saw of its hurts, step by step, by the post's id. */
const felt = new Map<string, (string | null)[]>();

const entry: WorldContent = {
  name: "move/poke",
  actions: [poke],
  register(game) {
    registerEntityType(game, "post", {
      radius: 10,
      maxHealth: 50,
      data: z.object({}),
      update(entity, data, _dt, session) {
        const hurtNow = hurtSinceLastStep(session, entity.id);
        if (hurtNow !== null)
          felt.set(entity.id, [...(felt.get(entity.id) ?? []), hurtNow.by]);
        return data;
      },
      strikes: (entity) => bites.get(entity.id) ?? [],
      draw: () => undefined,
    });
  },
  populate: () => undefined,
};

/** A dev-square session with the poke, its player at (100, 100). */
function session(localId = "me"): Session {
  bites.clear();
  felt.clear();
  const game = createSession(
    localId,
    localId.toUpperCase(),
    "HURT",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [entry]);
  Object.assign(game.local, { x: 100, y: 100 });
  return game;
}

function run(game: Session, steps = 1): void {
  for (let i = 0; i < steps; i++) updateSession(game, idle, DT);
}

test("a player and a world entity are both bodies; ghosts and the dead are not living ones", () => {
  const game = session();
  const post = spawnEntity(game, "post", 300, 100, {});
  const dead = spawnEntity(game, "post", 400, 100, {});
  dead.health = 0;
  const ghost = createPlayer(
    "ghost",
    "GHOST",
    { x: 500, y: 100 },
    testSimConfig,
  );
  game.players.set(ghost.id, ghost);
  setPlayerHealth(game, ghost, 0);

  expect(bodyById(game, "me")).toBe(game.local);
  expect(bodyById(game, post.id)).toBe(post);
  expect(bodyById(game, "nobody")).toBeNull();
  expect(livingBodies(game)).toEqual([game.local, post]);
  expect(isGone(game, ghost.id)).toBe(true);
  expect(isGone(game, dead.id)).toBe(true);
  expect(isGone(game, post.id)).toBe(false);
  expect(hasKindTag(game, "me", [PLAYER_TAG])).toBe(true);
  expect(hasKindTag(game, post.id, [PLAYER_TAG])).toBe(false);
});

test("hurt in the host's own action, a body is on record as hurt by the actor", () => {
  const game = session();
  const post = spawnEntity(game, "post", 150, 100, {});
  expect(poke.perform(game, { target: post.id })).toBe(true);
  expect(post.health).toBe(45);
  expect(lastHurt(game, post.id)).toEqual({ by: "me", at: game.worldTime });
  expect(lastHurtBy(game, post.id)).toBe("me");
});

test("a remote player's action the host applies puts that player on record, players hurt included", () => {
  const game = session();
  const them = createPlayer("them", "THEM", { x: 120, y: 100 }, testSimConfig);
  game.players.set(them.id, them);
  receiveEvent(
    game,
    {
      from: "them",
      to: null,
      content: "move/poke",
      event: "poke",
      payload: { action: 1, step: 0, input: { target: "me" } },
    },
    game.localId,
  );
  run(game, 10);
  expect(game.local.health).toBe(game.local.maxHealth - 5);
  expect(lastHurtBy(game, "me")).toBe("them");
});

test("a guest predicting its action puts no one on record; only the host does", () => {
  const game = session();
  const post = spawnEntity(game, "post", 150, 100, {});
  game.hosting = false;
  poke.perform(game, { target: post.id });
  expect(post.health).toBe(45);
  expect(lastHurt(game, post.id)).toBeNull();
});

test("a monster's strike is on record as its doing, or as whoever it names", () => {
  const game = session();
  const biter = spawnEntity(game, "post", 300, 100, {});
  const trap = spawnEntity(game, "post", 400, 100, {});
  const victim = spawnEntity(game, "post", 500, 100, {});
  bites.set(biter.id, [{ target: "me", amount: 3 }]);
  bites.set(trap.id, [{ target: victim.id, amount: 2, by: "me" }]);
  run(game);
  bites.clear();
  expect(game.local.health).toBe(game.local.maxHealth - 3);
  expect(lastHurtBy(game, "me")).toBe(biter.id);
  expect(victim.health).toBe(48);
  expect(lastHurtBy(game, victim.id)).toBe("me");
});

test("a shot is on record as its shooter's", () => {
  const game = session();
  const shooter = spawnEntity(game, "post", 400, 300, {});
  const target = spawnEntity(game, "post", 500, 300, {});
  shoot(game, shooter, { aim: 0, range: 300, damage: 7 }, { spark: 2 });
  expect(target.health).toBe(43);
  expect(lastHurtBy(game, target.id)).toBe(shooter.id);
});

test("hurt by no one is on record, by null", () => {
  const game = session();
  const post = spawnEntity(game, "post", 300, 100, {});
  hurt(game, post, 1, null);
  expect(lastHurt(game, post.id)).toEqual({ by: null, at: game.worldTime });
  expect(lastHurtBy(game, post.id)).toBeNull();
});

test("an attacker is forgotten past the window asked about, though still on record", () => {
  const game = session();
  const post = spawnEntity(game, "post", 300, 100, {});
  hurt(game, post, 1, "me");
  run(game, 60);
  expect(lastHurtBy(game, post.id, 0.5)).toBeNull();
  expect(lastHurtBy(game, post.id, 2)).toBe("me");
  expect(lastHurtBy(game, post.id)).toBe("me");
});

test("a kind sees each hurt once, in its next step, by whom; a stunned one once its stun ends", () => {
  const game = session();
  const post = spawnEntity(game, "post", 300, 100, {});
  const biter = spawnEntity(game, "post", 400, 100, {});
  hurt(game, post, 1, "me");
  run(game, 3);
  expect(felt.get(post.id)).toEqual(["me"]);

  // Struck by a body whose kind runs after its own, it sees it the step after.
  bites.set(biter.id, [{ target: post.id, amount: 1 }]);
  run(game);
  bites.clear();
  expect(felt.get(post.id)).toEqual(["me"]);
  run(game, 3);
  expect(felt.get(post.id)).toEqual(["me", biter.id]);

  stun(game, post.id, 0.2);
  hurt(game, post, 1, null);
  run(game, 6);
  expect(felt.get(post.id)).toEqual(["me", biter.id]);
  run(game, 12);
  expect(felt.get(post.id)).toEqual(["me", biter.id, null]);
});

test("the record is world data: a guest holds it, and goes on from it as the next host", () => {
  const host = session("me");
  const guest = session("you");
  guest.hosting = false;
  const post = spawnEntity(host, "post", 300, 100, {});
  spawnEntity(guest, "post", 300, 100, {});
  hurt(host, post, 1, "me");
  const entries = takeWorldEntries(host, false);
  expect(entries).not.toBeNull();
  applyWorldEntries(guest, { host: "me", term: 1 }, entries ?? {});
  expect(lastHurtBy(guest, post.id)).toBe("me");

  guest.hosting = true;
  expect(hurtSinceLastStep(guest, post.id)).toEqual({
    by: "me",
    at: host.worldTime,
  });
});

test("the hurts of bodies gone from the world are forgotten; a ghost's are kept", () => {
  const game = session();
  const post = spawnEntity(game, "post", 300, 100, {});
  const them = createPlayer("them", "THEM", { x: 500, y: 100 }, testSimConfig);
  const ghost = createPlayer(
    "ghost",
    "GHOST",
    { x: 600, y: 100 },
    testSimConfig,
  );
  game.players.set(them.id, them);
  game.players.set(ghost.id, ghost);
  hurt(game, post, 1, "me");
  hurt(game, them, 1, post.id);
  hurt(game, ghost, ghost.maxHealth, post.id);
  game.entities.delete(post.id);
  removePlayer(game, them.id);
  run(game);
  expect(Object.keys(lastHurts.get(game))).toEqual([ghost.id]);
  expect(lastHurtBy(game, ghost.id)).toBe(post.id);
});
