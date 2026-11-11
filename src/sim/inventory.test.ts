import { expect, test } from "vitest";
import type { ItemDefinition } from "./inventory.js";
import {
  addItem,
  createInventory,
  heldItem,
  isFull,
  placeItem,
  removeItem,
  selectSlot,
} from "./inventory.js";

const material: ItemDefinition = {
  id: "material",
  name: "Material",
  emoji: "🪨",
};

const tool: ItemDefinition = { id: "tool", name: "Tool", emoji: "🔧" };

const ids = (inventory: ReturnType<typeof createInventory>) =>
  inventory.map((item) => item?.id ?? null);

test("each item takes a slot of its own, the same item included", () => {
  const inventory = createInventory(3);
  expect(addItem(inventory, material)).toBe(true);
  expect(addItem(inventory, material)).toBe(true);
  expect(ids(inventory)).toEqual(["material", "material", null]);
});

test("an item fills the first empty slot", () => {
  const inventory = createInventory(3);
  placeItem(inventory, 0, tool);
  placeItem(inventory, 2, tool);
  addItem(inventory, material);
  expect(ids(inventory)).toEqual(["tool", "material", "tool"]);
});

test("a full inventory takes nothing more", () => {
  const inventory = createInventory(2);
  addItem(inventory, material);
  expect(isFull(inventory)).toBe(false);
  addItem(inventory, tool);
  expect(isFull(inventory)).toBe(true);
  expect(addItem(inventory, material)).toBe(false);
  expect(ids(inventory)).toEqual(["material", "tool"]);
});

test("removing empties the slot and returns what it held", () => {
  const inventory = createInventory(2);
  addItem(inventory, material);
  expect(removeItem(inventory, 0)).toBe(material);
  expect(inventory[0]).toBeNull();
  expect(removeItem(inventory, 0)).toBeNull();
});

test("rejects invalid inventory operations", () => {
  expect(() => createInventory(0)).toThrow(RangeError);
  const inventory = createInventory(1);
  expect(() => removeItem(inventory, 2)).toThrow(RangeError);
  expect(() => {
    placeItem(inventory, 1, tool);
  }).toThrow(RangeError);
  placeItem(inventory, 0, tool);
  expect(() => {
    placeItem(inventory, 0, material);
  }).toThrow(RangeError);
});

test("selects slots by number, including empty ones", () => {
  const inventory = createInventory(3);
  addItem(inventory, material);
  expect(heldItem(inventory, selectSlot(inventory, 2, 0))?.id).toBe("material");
  expect(selectSlot(inventory, 0, 2)).toBe(2);
  expect(heldItem(inventory, selectSlot(inventory, 0, 2))).toBeNull();
});

test("a slot number past either end keeps the held slot", () => {
  const inventory = createInventory(3);
  expect(selectSlot(inventory, 1, 3)).toBe(1);
  expect(selectSlot(inventory, 1, -1)).toBe(1);
  expect(selectSlot(inventory, null, 8)).toBeNull();
});
