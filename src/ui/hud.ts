import type { HeldSlot, Inventory } from "../sim/index.js";

export function createInventoryHud(
  container: HTMLElement,
  list: HTMLElement,
): (inventory: Inventory, selected: HeldSlot, visible: boolean) => void {
  let previous = "";

  return function updateInventory(inventory, selected, visible) {
    container.hidden = !visible;
    if (!visible) return;

    const signature = JSON.stringify([inventory, selected]);
    if (signature === previous) return;
    previous = signature;

    list.replaceChildren(
      ...inventory.map((item, index) => {
        const slot = document.createElement("li");
        const number = document.createElement("span");
        const contents = document.createElement("span");

        if (index === selected) slot.className = "selected";
        number.className = "slot-number";
        number.textContent = String(index + 1);
        contents.textContent =
          item === null ? "Empty" : `${item.emoji} ${item.name}`;

        slot.append(number, contents);
        return slot;
      }),
    );
  };
}
