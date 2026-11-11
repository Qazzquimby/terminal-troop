import { expect, test } from "vitest";
import type { ItemDefinition } from "./inventory.js";
import {
  addItem,
  createInventory,
  heldItem,
  removeItem,
  selectSlot,
} from "./inventory.js";

const material: ItemDefinition = {
  id: "material",
  name: "Material",
  maxStack: 5,
  emoji: "🪨",
};

const quantities = (inventory: ReturnType<typeof createInventory>): number[] =>
  inventory.map((stack) => stack?.quantity ?? 0);

test("fills existing stacks before empty slots", () => {
  const inventory = createInventory(3);
  expect(addItem(inventory, material, 3)).toBe(0);
  expect(addItem(inventory, material, 4)).toBe(0);
  expect(quantities(inventory)).toEqual([5, 2, 0]);
});

test("returns overflow without exceeding capacity", () => {
  const inventory = createInventory(2);
  expect(addItem(inventory, material, 12)).toBe(2);
  expect(quantities(inventory)).toEqual([5, 5]);
});

test("removes only the available quantity and clears empty slots", () => {
  const inventory = createInventory(2);
  addItem(inventory, material, 4);
  expect(removeItem(inventory, 0, 2)).toBe(2);
  expect(inventory[0]?.quantity).toBe(2);
  expect(removeItem(inventory, 0, 10)).toBe(2);
  expect(inventory[0]).toBeNull();
  expect(removeItem(inventory, 0, 1)).toBe(0);
});

test("rejects invalid inventory operations", () => {
  expect(() => createInventory(0)).toThrow(RangeError);
  const inventory = createInventory(1);
  expect(() => addItem(inventory, material, -1)).toThrow(RangeError);
  expect(() => addItem(inventory, material, 1.5)).toThrow(RangeError);
  expect(() => removeItem(inventory, 2, 1)).toThrow(RangeError);
  expect(() => addItem(inventory, { ...material, maxStack: 0 }, 1)).toThrow(
    RangeError,
  );
});

test("keeps different item types separate", () => {
  const inventory = createInventory(2);
  const tool: ItemDefinition = {
    id: "tool",
    name: "Tool",
    maxStack: 1,
    emoji: "🔧",
  };
  addItem(inventory, material, 2);
  expect(addItem(inventory, tool, 2)).toBe(1);
  expect(inventory[0]?.item.id).toBe("material");
  expect(inventory[1]?.item.id).toBe("tool");
});

test("selects slots by number, including empty ones", () => {
  const inventory = createInventory(3);
  addItem(inventory, material, 1);
  expect(heldItem(inventory, selectSlot(inventory, 2, 0))?.item.id).toBe(
    "material",
  );
  expect(heldItem(inventory, selectSlot(inventory, 0, 2))).toBeNull();
});

test("a slot number past either end keeps the held slot", () => {
  const inventory = createInventory(3);
  expect(selectSlot(inventory, 1, 3)).toBe(1);
  expect(selectSlot(inventory, 1, -1)).toBe(1);
  expect(selectSlot(inventory, null, 8)).toBeNull();
});
