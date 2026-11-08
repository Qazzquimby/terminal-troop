import type { Inventory } from "./inventory.js";

export function createInventoryHud(
  container: HTMLElement,
  list: HTMLElement,
): (inventory: Inventory, visible: boolean) => void {
  let previous = "";

  return function updateInventory(inventory, visible) {
    container.hidden = !visible;
    if (!visible) return;

    const signature = JSON.stringify(inventory);
    if (signature === previous) return;
    previous = signature;

    list.replaceChildren(
      ...inventory.map((stack, index) => {
        const slot = document.createElement("li");
        const number = document.createElement("span");
        const contents = document.createElement("span");

        number.className = "slot-number";
        number.textContent = String(index + 1);
        contents.textContent =
          stack === null
            ? "Empty"
            : `${stack.item.name} × ${String(stack.quantity)}`;

        slot.append(number, contents);
        return slot;
      }),
    );
  };
}
