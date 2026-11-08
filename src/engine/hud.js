export function createInventoryHud(container, list) {
  let previous = "";

  return function updateInventory(inventory, visible) {
    container.hidden = !visible;
    if (!visible) return;

    const signature = JSON.stringify(inventory);
    if (signature === previous) return;
    previous = signature;

    list.replaceChildren(...inventory.map((stack, index) => {
      const slot = document.createElement("li");
      const number = document.createElement("span");
      const contents = document.createElement("span");

      number.className = "slot-number";
      number.textContent = String(index + 1);
      contents.textContent = stack
        ? `${stack.item.name} × ${stack.quantity}`
        : "Empty";

      slot.append(number, contents);
      return slot;
    }));
  };
}
