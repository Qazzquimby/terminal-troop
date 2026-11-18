import { expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import { giveItem, spawnWorldItem, usesAt } from "../sim/index.js";
import type { Controls, Point } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testItemsConfig } from "./sim-config.js";

const config = testItemsConfig.itemScanner;
const GUEST = { x: 300, y: 300 };

const facingRight: Controls = { ...idle, aim: { x: 900, y: 300 } };
const facingLeft: Controls = { ...idle, aim: { x: -300, y: 300 } };

async function room(item: Point) {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 900 }, b: GUEST },
      content: itemContent(testItemsConfig),
    },
    "a",
    "b",
  );
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  spawnWorldItem(host, item, "scrap");
  expect(giveItem(host, "b", "itemScanner", 1)).toBe(true);
  guest.local.held = 1;
  made.run(300, { b: facingRight });
  const beeps = vi.spyOn(guest.sfx, "play");
  /** Beeps the guest heard over `ms`, facing as `controls` say. */
  const count = (ms: number, controls: Controls): number => {
    beeps.mockClear();
    made.run(ms, { b: controls });
    return beeps.mock.calls.filter(([url]) => url.includes("item-beep")).length;
  };
  const battery = () => usesAt(host, playerOn(made.room("a"), "b"), 1);
  return { ...made, count, battery };
}

test("switched off it is silent; on, it beeps faster facing an item than facing away", async () => {
  const { step, count } = await room({ x: 500, y: 300 });
  expect(count(3000, facingRight)).toBe(0);

  step({ b: { ...facingRight, use: true } });
  const faced = count(4000, facingRight);
  const away = count(4000, facingLeft);
  expect(away).toBeGreaterThan(0);
  expect(faced).toBeGreaterThan(away);
});

test("it beeps faster nearer, and drains its battery like a flashlight", async () => {
  const near = await room({ x: 360, y: 300 });
  near.step({ b: { ...facingRight, use: true } });
  const nearBeeps = near.count(4000, facingRight);
  expect(near.battery()).toBeLessThan(config.uses ?? 0);

  const far = await room({ x: 1100, y: 300 });
  far.step({ b: { ...facingRight, use: true } });
  expect(nearBeeps).toBeGreaterThan(far.count(4000, facingRight));
});

test("dropped switched on, it beeps on where it lies, as it points, whichever way its dropper turns", async () => {
  const dropped = async (pointing: Controls): Promise<number> => {
    const made = await room({ x: 500, y: 300 });
    made.step({ b: { ...pointing, use: true } });
    made.run(300, { b: pointing });
    made.step({ b: { ...pointing, drop: true } });
    made.run(300, { b: pointing });
    // Turned the other way, the dropper's own facing must make no difference.
    const away = pointing === facingRight ? facingLeft : facingRight;
    return made.count(6000, away);
  };
  const facingIt = await dropped(facingRight);
  const facingAway = await dropped(facingLeft);
  expect(facingAway).toBeGreaterThan(0);
  expect(facingIt).toBeGreaterThan(facingAway);
});

test("put away in a pocket it switches off and falls silent", async () => {
  const { step, run, count } = await room({ x: 500, y: 300 });
  step({ b: { ...facingRight, use: true } });
  expect(count(2000, facingRight)).toBeGreaterThan(0);
  run(300, { b: { ...facingRight, select: 0 } });
  run(300, { b: { ...facingRight, select: 1 } });
  expect(count(3000, facingRight)).toBe(0);
});
