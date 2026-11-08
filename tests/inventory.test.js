import test from "node:test";
import assert from "node:assert/strict";
import {
  addItem,
  createInventory,
  removeItem,
} from "../src/engine/inventory.js";

const material = Object.freeze({
  id: "material",
  name: "Material",
  maxStack: 5,
});

test("fills existing stacks before empty slots", () => {
  const inventory = createInventory(3);
  assert.equal(addItem(inventory, material, 3), 0);
  assert.equal(addItem(inventory, material, 4), 0);
  assert.deepEqual(inventory.map((stack) => stack?.quantity ?? 0), [5, 2, 0]);
});

test("returns overflow without exceeding capacity", () => {
  const inventory = createInventory(2);
  assert.equal(addItem(inventory, material, 12), 2);
  assert.deepEqual(inventory.map((stack) => stack.quantity), [5, 5]);
});

test("removes only the available quantity and clears empty slots", () => {
  const inventory = createInventory(2);
  addItem(inventory, material, 4);
  assert.equal(removeItem(inventory, 0, 2), 2);
  assert.equal(inventory[0].quantity, 2);
  assert.equal(removeItem(inventory, 0, 10), 2);
  assert.equal(inventory[0], null);
  assert.equal(removeItem(inventory, 0, 1), 0);
});

test("rejects invalid inventory operations", () => {
  assert.throws(() => createInventory(0), RangeError);
  const inventory = createInventory(1);
  assert.throws(() => addItem(inventory, material, -1), RangeError);
  assert.throws(() => addItem(inventory, material, 1.5), RangeError);
  assert.throws(() => removeItem(inventory, 2, 1), RangeError);
  assert.throws(
    () => addItem(inventory, { ...material, maxStack: 0 }, 1),
    RangeError,
  );
});

test("keeps different item types separate", () => {
  const inventory = createInventory(2);
  const tool = { id: "tool", name: "Tool", maxStack: 1 };
  addItem(inventory, material, 2);
  assert.equal(addItem(inventory, tool, 2), 1);
  assert.equal(inventory[0].item.id, "material");
  assert.equal(inventory[1].item.id, "tool");
});
