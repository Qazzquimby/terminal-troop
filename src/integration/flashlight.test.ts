import { expect, test } from "vitest";
import { itemContent } from "../items/index.js";
import {
  emittedLights,
  giveItem,
  isLit,
  isOn,
  itemInstances,
  usesAt,
} from "../sim/index.js";
import type { Controls } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testItemsConfig } from "./sim-config.js";

const GUEST = { x: 300, y: 300 };
/** Ahead of the guest as it faces right, past its own sight in the dark. */
const AHEAD = { x: 520, y: 330 };
const BATTERY = testItemsConfig.flashlight.uses ?? 0;

/** Facing right, from where the guest stands. */
const facing: Controls = { ...idle, aim: { x: 900, y: 300 } };
const switching: Controls = { ...facing, use: true };
/** Facing left, away from AHEAD. */
const facingAway: Controls = { ...idle, aim: { x: -300, y: 300 } };
/** Behind the guest as it faces right, past its own sight in the dark. */
const BEHIND = { x: 80, y: 270 };

async function room(delay?: () => number) {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 500 }, b: GUEST },
      content: itemContent(testItemsConfig),
      ...(delay !== undefined && { delay }),
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  /** As the host, gives the guest a flashlight in slot 1 with `left` uses, held. */
  const stock = (left?: number): void => {
    expect(giveItem(host, "b", "flashlight", 1, left)).toBe(true);
    guest.local.held = 1;
    made.run(300, { b: facing });
  };
  const battery = () => usesAt(host, playerOn(made.room("a"), "b"), 1);
  return { ...made, host, guest, stock, battery };
}

test("a flashlight switched on lights a long cone ahead of its holder, on every client", async () => {
  const { host, guest, step, run, stock } = await room();
  stock();
  expect(isLit(host, AHEAD)).toBe(false);
  expect(isLit(guest, AHEAD)).toBe(false);

  step({ b: switching });
  run(300, { b: facing });

  for (const game of [host, guest]) {
    expect(isLit(game, AHEAD)).toBe(true);
    expect(isLit(game, { x: 100, y: 300 })).toBe(false);
    const fromGuest = emittedLights(game).filter(
      (light) => Math.hypot(light.x - GUEST.x, light.y - GUEST.y) < 5,
    );
    expect(fromGuest.map((light) => light.shape?.kind)).toEqual(["cone"]);
  }

  step({ b: switching });
  run(300, { b: facing });
  expect(isLit(host, AHEAD)).toBe(false);
  expect(isLit(guest, AHEAD)).toBe(false);
});

test("its battery drains a use each second it shines, and only while it shines", async () => {
  const { step, run, stock, battery } = await room();
  stock();
  run(2000, { b: facing });
  expect(battery()).toBe(BATTERY);

  step({ b: switching });
  run(3500, { b: facing });
  expect(battery()).toBe(BATTERY - 3);
});

test("a flat battery leaves no flashlight, and no light", async () => {
  const { host, guest, step, run, stock } = await room();
  stock(2);
  step({ b: switching });
  run(2500, { b: facing });
  expect(guest.local.inventory[1]).toBeNull();
  expect(isLit(host, AHEAD)).toBe(false);
});

test("putting it away switches it off", async () => {
  const { host, guest, step, run, stock } = await room();
  stock();
  step({ b: switching });
  run(300, { b: facing });
  expect(isLit(host, AHEAD)).toBe(true);

  run(300, { b: { ...facing, select: 0 } });
  run(300, { b: { ...facing, select: 1 } });
  expect(guest.local.held).toBe(1);
  expect(isLit(host, AHEAD)).toBe(false);
  expect(isLit(guest, AHEAD)).toBe(false);
});

test("its holder's own client lights it at once, before the host answers", async () => {
  const { host, guest, step, run, stock } = await room(() => 150);
  stock();
  step({ b: switching });
  expect(isLit(guest, AHEAD)).toBe(true);
  expect(isLit(host, AHEAD)).toBe(false);
  run(600, { b: facing });
  expect(isLit(host, AHEAD)).toBe(true);
  expect(isLit(guest, AHEAD)).toBe(true);
});

test("dropped switched on, it shines on the way it faced as it fell, whichever way its dropper turns", async () => {
  const { host, guest, step, run, stock } = await room();
  stock();
  step({ b: switching });
  run(300, { b: facing });
  step({ b: { ...facing, drop: true } });
  run(300, { b: facingAway });

  const [lying] = itemInstances(host, "flashlight");
  expect(lying !== undefined && "lying" in lying.place).toBe(true);
  expect(isOn(lying?.state)).toBe(true);
  for (const game of [host, guest]) {
    expect(isLit(game, AHEAD)).toBe(true);
    expect(isLit(game, BEHIND)).toBe(false);
  }
});

test("lying switched on, its battery drains and goes flat; picked up, it is still on", async () => {
  const { host, guest, step, run, stock } = await room();
  stock(6);
  step({ b: switching });
  run(300, { b: facing });
  step({ b: { ...facing, drop: true } });
  run(2500, { b: facing });
  const [lying] = itemInstances(host, "flashlight");
  expect(lying?.left).toBeLessThanOrEqual(4);
  expect(lying?.left).toBeGreaterThanOrEqual(3);

  step({ b: { ...facing, interact: true } });
  run(300, { b: facing });
  const carried = guest.local.inventory.find(
    (item) => item?.id === "flashlight",
  );
  expect(isOn(carried?.state)).toBe(true);
  run(5000, { b: facing });
  expect(itemInstances(host, "flashlight")).toEqual([]);
});

test("dropped switched off, it stays dark and keeps its battery", async () => {
  const { host, step, run, stock } = await room();
  stock(6);
  step({ b: { ...facing, drop: true } });
  run(3000, { b: facing });
  const [lying] = itemInstances(host, "flashlight");
  expect(lying?.left).toBe(6);
  expect(isOn(lying?.state)).toBe(false);
  expect(isLit(host, AHEAD)).toBe(false);
});
