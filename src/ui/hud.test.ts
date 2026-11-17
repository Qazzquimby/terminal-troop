import { expect, test } from "vitest";
import type { Inventory } from "../sim/index.js";
import {
  bankedText,
  createHud,
  creditText,
  departureText,
  slotViews,
  weightText,
} from "./hud.js";

const CONFIG = { segmentsUpTo: 10 };
const shovel = { id: "shovel", name: "Shovel", emoji: "🪏", weight: 15 };
const blank = {
  glyph: "",
  glint: null,
  name: "",
  weight: "",
  uses: null,
  on: false,
};

test("every slot shows its key number, the held one marked, an empty one blank", () => {
  const inventory: Inventory = [shovel, null, null];
  expect(slotViews(inventory, 2, CONFIG)).toEqual([
    {
      number: "1",
      glyph: "🪏",
      glint: null,
      name: "Shovel",
      weight: "15 lb",
      uses: null,
      selected: false,
      on: false,
    },
    { number: "2", ...blank, selected: false },
    { number: "3", ...blank, selected: true },
  ]);
  expect(slotViews(inventory, null, CONFIG).some((slot) => slot.selected)).toBe(
    false,
  );
});

test("an item of few uses shows a bar of a segment per use, and what is left of them", () => {
  const torch = { id: "torch", name: "Torch", emoji: "🔦", uses: 5, left: 2 };
  const [view] = slotViews([torch], null, CONFIG);
  expect(view?.uses).toEqual({ text: "2/5", fill: 0.4, segments: 5 });
});

test("an item of many uses shows one bar; one that has spent none shows them all", () => {
  const drill = { id: "drill", name: "Drill", emoji: "🛠", uses: 30 };
  const [fresh] = slotViews([drill], null, CONFIG);
  expect(fresh?.uses).toEqual({ text: "30/30", fill: 1, segments: null });
  const [worn] = slotViews([{ ...drill, left: 15 }], null, CONFIG);
  expect(worn?.uses).toEqual({ text: "15/30", fill: 0.5, segments: null });
});

test("weight reads as whole pounds", () => {
  expect(weightText(0)).toBe("0 lb");
  expect(weightText(30)).toBe("30 lb");
  expect(weightText(12.6)).toBe("13 lb");
});

test("credit reads as a count of dollars after the number", () => {
  expect(creditText(0)).toBe("0$");
  expect(creditText(12)).toBe("12$");
  expect(creditText(-4)).toBe("-4$");
});

test("the credit shows with the quota to bank beside it", () => {
  expect(bankedText(12, 30)).toBe("12$ / 30$");
  expect(bankedText(-4, 30)).toBe("-4$ / 30$");
});

test("the departure counts down in whole seconds, says when the player escaped, and is blank otherwise", () => {
  expect(departureText(false, null)).toBe("");
  expect(departureText(false, 20)).toBe("Leaving in 20s");
  expect(departureText(false, 12.2)).toBe("Leaving in 13s");
  expect(departureText(true, 5)).toBe("Escaped");
  expect(departureText(true, null)).toBe("Escaped");
  expect(departureText(false, null, 5)).toBe("Need 5$ more to leave");
  expect(departureText(true, null, 5)).toBe("Escaped");
});

test("an item switched on shows as on; one with no state, or off, does not", () => {
  const walkie = { id: "walkie", name: "Walkie", emoji: "📻" };
  const inventory: Inventory = [
    { ...walkie, state: { on: true } },
    walkie,
    { ...walkie, state: { on: false } },
  ];
  const views = slotViews(inventory, null, CONFIG);
  expect(views.map((view) => view.on)).toEqual([true, false, false]);
});

test("outside a room the bar is hidden, and nothing is drawn into it", () => {
  const bar = { hidden: false };
  const slots = {
    replaceChildren: () => {
      throw new Error("drawn while hidden");
    },
  };
  const credit = { textContent: "" };
  const weight = { textContent: "" };
  const departure = { textContent: "" };
  const hud = createHud({ bar, slots, credit, weight, departure }, CONFIG);
  hud.show(null);
  expect(bar.hidden).toBe(true);
  expect(credit.textContent).toBe("");
  expect(weight.textContent).toBe("");
});
