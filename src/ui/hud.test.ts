import { expect, test } from "vitest";
import type { Inventory } from "../sim/index.js";
import { createHud, creditText, slotViews } from "./hud.js";

const shovel = { id: "shovel", name: "Shovel", emoji: "🪏" };

test("every slot shows its key number, the held one marked, an empty one blank", () => {
  const inventory: Inventory = [shovel, null, null];
  expect(slotViews(inventory, 2)).toEqual([
    { number: "1", glyph: "🪏", name: "Shovel", selected: false },
    { number: "2", glyph: "", name: "", selected: false },
    { number: "3", glyph: "", name: "", selected: true },
  ]);
  expect(slotViews(inventory, null).some((slot) => slot.selected)).toBe(false);
});

test("credit reads as a count of dollars after the number", () => {
  expect(creditText(0)).toBe("0$");
  expect(creditText(12)).toBe("12$");
});

test("outside a room the bar is hidden, and nothing is drawn into it", () => {
  const bar = { hidden: false };
  const slots = {
    replaceChildren: () => {
      throw new Error("drawn while hidden");
    },
  };
  const credit = { textContent: "" };
  const hud = createHud({ bar, slots, credit });
  hud.show(null);
  expect(bar.hidden).toBe(true);
  expect(credit.textContent).toBe("");
});
