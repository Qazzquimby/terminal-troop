import { expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import type { Room } from "../room/index.js";
import { giveItem, isAreaFree, PLAYER_TAG, usesAt } from "../sim/index.js";
import type { Controls, Point } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testItemsConfig, testSimConfig } from "./sim-config.js";

const { handgun, shotgun } = testItemsConfig;
const FULL = testSimConfig.player.maxHealth;
/** Open floor in the dev square, the host's player 300px to the guest's right. */
const GUEST = { x: 100, y: 300 };
const HOST = { x: 400, y: 300 };
/** Either side of the pillar at x 200..300, y 50..150. */
const BEFORE_PILLAR = { x: 100, y: 100 };
const SHELTERED = { x: 400, y: 100 };

async function room() {
  const made = await crew(
    { spots: { a: HOST, b: GUEST }, content: itemContent(testItemsConfig) },
    "a",
    "b",
  );
  for (const each of made.rooms.values())
    vi.spyOn(sessionOf(each).sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  /** As the host, gives the guest `item` in slot 1 and holds it, and lets the record reach it. */
  const arm = (item: string): void => {
    expect(giveItem(host, "b", item, 1)).toBe(true);
    guest.local.held = 1;
    made.run(300);
  };
  /** What each client saw and heard over `ms`: the tracers drawn, and the noises made. */
  const watch = (ms: number, controls: Record<string, Controls> = {}) => {
    const tracers = new Map<string, number>();
    const noises: unknown[] = [];
    for (let at = 0; at < ms; at += 1000 / 60) {
      made.step(controls);
      controls = {};
      for (const [id, each] of made.rooms) {
        const game = sessionOf(each);
        const drawn = game.flashes.filter(
          (flash) => flash.from !== undefined,
        ).length;
        tracers.set(id, (tracers.get(id) ?? 0) + drawn);
        if (id === "a") noises.push(...game.noises);
      }
    }
    return { tracers, noises };
  };
  return { ...made, host, guest, arm, watch };
}

/** Fires the held item at `target`. */
const fireAt = (target: Point): Controls => ({
  ...idle,
  use: true,
  aim: target,
});

const healthOf = (client: Room, id: string): number =>
  playerOn(client, id).health;

test("a handgun shot hurts a fellow player for its damage, spends a use, and every client sees its tracer", async () => {
  const { room: client, guest, host, arm, watch } = await room();
  arm("handgun");
  const seen = watch(500, { b: fireAt(HOST) });
  expect(healthOf(client("a"), "a")).toBe(FULL - handgun.damage);
  expect(healthOf(client("b"), "a")).toBe(FULL - handgun.damage);
  expect(usesAt(host, playerOn(client("a"), "b"), 1)).toBe(
    (handgun.uses ?? 0) - 1,
  );
  expect(guest.local.inventory[1]?.left).toBe((handgun.uses ?? 0) - 1);
  expect(Object.fromEntries(seen.tracers)).toEqual({ a: 1, b: 1 });
});

test("a handgun shot is loud: a noise as far as its noise radius, tagged as a player's", async () => {
  const { arm, watch } = await room();
  arm("handgun");
  const { noises } = watch(500, { b: fireAt(HOST) });
  expect(noises).toContainEqual(
    expect.objectContaining({
      radius: handgun.noiseRadius,
      source: "b",
      tags: [PLAYER_TAG],
    }),
  );
});

test("a wall stops a shot: nobody behind it is hurt", async () => {
  const { room: client, place, arm, watch } = await room();
  place("a", SHELTERED);
  place("b", BEFORE_PILLAR);
  arm("handgun");
  watch(500, { b: fireAt(SHELTERED) });
  expect(healthOf(client("a"), "a")).toBe(FULL);
});

test("a shotgun blast fans its shots: all of them hit a player point blank, few far off", async () => {
  const { room: client, place, arm, watch, guest } = await room();
  place("a", { x: GUEST.x + 40, y: GUEST.y });
  arm("shotgun");
  const close = watch(1200, { b: fireAt(HOST) });
  const pellets = shotgun.pellets ?? 1;
  expect(healthOf(client("a"), "a")).toBe(FULL - shotgun.damage * pellets);
  expect(Object.fromEntries(close.tracers)).toEqual({ a: pellets, b: pellets });
  expect(guest.local.inventory[1]?.left).toBe((shotgun.uses ?? 0) - 1);

  place("a", { x: GUEST.x + 200, y: GUEST.y });
  watch(1200, { b: fireAt({ x: GUEST.x + 1000, y: GUEST.y }) });
  const lost = FULL - shotgun.damage * pellets - healthOf(client("a"), "a");
  expect(lost).toBeGreaterThan(0);
  expect(lost).toBeLessThan(shotgun.damage * pellets);
  expect(guest.local.inventory[1]).toBeNull();
});

test("a gun's last shot spends it", async () => {
  const { arm, watch, guest } = await room();
  arm("handgun");
  for (let shot = 0; shot < (handgun.uses ?? 0); shot++)
    watch(handgun.cooldown * 1000 + 100, { b: fireAt(HOST) });
  expect(guest.local.inventory[1]).toBeNull();
});

test("the spots the tests use are open floor, with the pillar between two of them", async () => {
  const { host } = await room();
  const { map } = host.world;
  for (const at of [GUEST, HOST, BEFORE_PILLAR, SHELTERED])
    expect(isAreaFree(map, at.x, at.y, testSimConfig.player.radius)).toBe(true);
  expect(isAreaFree(map, 250, 100, 1)).toBe(false);
});
