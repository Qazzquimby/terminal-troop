import type { HeldSlot, Inventory } from "../sim/index.js";

export interface Hud {
  inventory(inventory: Inventory, selected: HeldSlot): void;
  credit(credit: number): void;
}

/**
 * The bottom toolbar: every inventory slot with the selected one highlighted, and the credit
 * count beside it. Built here rather than looked up so it is always on screen.
 */
export function createHud(): Hud {
  const bar = document.createElement("div");
  bar.className = "hud-bar";

  const list = document.createElement("ol");
  list.className = "hud-slots";

  const credit = document.createElement("span");
  credit.className = "hud-credit";

  bar.append(list, credit);
  document.body.append(bar);

  let inventoryShown = "";
  let creditShown = -1;

  return {
    inventory(inventory, selected) {
      const signature = JSON.stringify([inventory, selected]);
      if (signature === inventoryShown) return;
      inventoryShown = signature;

      list.replaceChildren(
        ...inventory.map((item, index) => {
          const slot = document.createElement("li");
          slot.className = "hud-slot";
          slot.classList.toggle("selected", index === selected);

          const number = document.createElement("span");
          number.className = "slot-number";
          number.textContent = String(index + 1);

          const glyph = document.createElement("span");
          glyph.className = "hud-slot-glyph";
          if (item !== null) glyph.textContent = item.emoji;

          const name = document.createElement("span");
          name.className = "hud-slot-name";
          if (item !== null) name.textContent = item.name;

          slot.append(number, glyph, name);
          return slot;
        }),
      );
    },
    credit(value) {
      if (value === creditShown) return;
      creditShown = value;
      credit.textContent = `${String(value)}$`;
    },
  };
}

