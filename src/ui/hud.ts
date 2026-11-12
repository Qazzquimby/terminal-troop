import type { HeldSlot, Inventory } from "../sim/index.js";

/** What the toolbar shows while in a room. */
export interface HudState {
  readonly inventory: Inventory;
  readonly held: HeldSlot;
  /** The team's credit. */
  readonly credit: number;
}

/** One slot of the toolbar: its key number, and its item's glyph and name, blank when empty. */
interface SlotView {
  readonly number: string;
  readonly glyph: string;
  readonly name: string;
  readonly selected: boolean;
}

/** Each inventory slot as the toolbar shows it. */
export function slotViews(inventory: Inventory, held: HeldSlot): SlotView[] {
  return inventory.map((item, index) => ({
    number: String(index + 1),
    glyph: item?.emoji ?? "",
    name: item?.name ?? "",
    selected: index === held,
  }));
}

export function creditText(credit: number): string {
  return `${String(credit)}$`;
}

interface HudElements {
  readonly bar: Pick<HTMLElement, "hidden">;
  readonly slots: Pick<HTMLOListElement, "replaceChildren">;
  readonly credit: Pick<HTMLElement, "textContent">;
}

function slotElement(view: SlotView): HTMLLIElement {
  const slot = document.createElement("li");
  slot.className = "hud-slot";
  slot.classList.toggle("selected", view.selected);
  const parts = [
    ["slot-number", view.number],
    ["hud-slot-glyph", view.glyph],
    ["hud-slot-name", view.name],
  ] as const;
  slot.append(
    ...parts.map(([className, text]) => {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      return span;
    }),
  );
  return slot;
}

/**
 * The bottom toolbar: every inventory slot, the held one highlighted, and the team's credit
 * beside them. Shown while in a room; hidden by showing null.
 */
export function createHud(elements: HudElements) {
  let shownSlots = "";
  let shownCredit = "";
  return {
    show(state: HudState | null): void {
      elements.bar.hidden = state === null;
      if (state === null) return;
      const views = slotViews(state.inventory, state.held);
      const signature = JSON.stringify(views);
      if (signature !== shownSlots) {
        shownSlots = signature;
        elements.slots.replaceChildren(...views.map(slotElement));
      }
      const credit = creditText(state.credit);
      if (credit !== shownCredit) {
        shownCredit = credit;
        elements.credit.textContent = credit;
      }
    },
  };
}
