import { expect, test } from "vitest";
import type { ItemDefinition } from "./inventory.js";
import {
  addItem,
  cycleSlot,
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
  expect(heldItem(inventory, selectSlot(inventory, 0))?.id).toBe("material");
  expect(selectSlot(inventory, 2)).toBe(2);
  expect(heldItem(inventory, selectSlot(inventory, 2))).toBeNull();
});

test("a slot number past either end holds nothing", () => {
  const inventory = createInventory(3);
  expect(selectSlot(inventory, 3)).toBeNull();
  expect(selectSlot(inventory, 8)).toBeNull();
  expect(selectSlot(inventory, -1)).toBeNull();
});

test("cycling steps through every slot, empty ones too, and wraps at both ends", () => {
  const inventory = createInventory(3);
  addItem(inventory, tool);
  expect(cycleSlot(inventory, 0, 1)).toBe(1);
  expect(cycleSlot(inventory, 1, 1)).toBe(2);
  expect(cycleSlot(inventory, 2, 1)).toBe(0);
  expect(cycleSlot(inventory, 0, -1)).toBe(2);
  expect(cycleSlot(inventory, 1, -1)).toBe(0);
  expect(cycleSlot(inventory, 1, 0)).toBe(1);
});

test("cycling from holding nothing holds the first slot forward and the last back", () => {
  const inventory = createInventory(4);
  expect(cycleSlot(inventory, null, 1)).toBe(0);
  expect(cycleSlot(inventory, null, -1)).toBe(3);
  expect(cycleSlot(inventory, null, 0)).toBeNull();
  expect(cycleSlot([], 0, 1)).toBeNull();
});
