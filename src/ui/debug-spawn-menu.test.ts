import { expect, test } from "vitest";
import { filterChoices } from "./debug-spawn-menu.js";

const choices = [
  { what: "monster", kind: "blind-dog", label: "blind-dog" },
  { what: "monster", kind: "zombie", label: "zombie" },
  { what: "item", kind: "golden-scrap", label: "Golden scrap" },
  { what: "item", kind: "scrap", label: "Scrap" },
];

test("an empty filter keeps every choice, in order", () => {
  expect(filterChoices(choices, "  ")).toEqual(choices);
});

test("the filter keeps choices holding every word of it, by label, key or group, ignoring case", () => {
  expect(filterChoices(choices, "SCRAP").map((c) => c.kind)).toEqual([
    "golden-scrap",
    "scrap",
  ]);
  expect(filterChoices(choices, "scrap gold").map((c) => c.kind)).toEqual([
    "golden-scrap",
  ]);
  expect(filterChoices(choices, "monster").map((c) => c.kind)).toEqual([
    "blind-dog",
    "zombie",
  ]);
});
