import { cabinShop, cabinStorage, glyphOf, usesLeft } from "../sim/index.js";
import type { CarriedItem, Inventory, Session } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel, CabinSend } from "./cabin.js";
import { creditText } from "./hud.js";

/*
 * The cabin's storage and shop panels. Each asks the vehicle through `send`, like every other
 * cabin control; what the storage holds and what the team can spend come from the host's record,
 * so every occupant sees the same.
 */

/** How many storage slots the cabin lays out to a row. */
const STORAGE_COLUMNS = 3;

/** An item as a slot button shows it: its glyph, and its uses left when they run out. */
function label(item: CarriedItem | null): string {
  if (item === null) return "·";
  const left = usesLeft(item);
  const glyph = glyphOf(item, item.state);
  return left === null ? glyph : `${glyph}${String(left)}`;
}

/** A slot button for `item`, its name as its tooltip, or `empty` for none. */
function slotButton(
  className: string,
  item: CarriedItem | null,
  empty: string,
  click: () => void,
): HTMLButtonElement {
  const slot = button(className, label(item), click);
  slot.title = item === null ? empty : item.name;
  if (item === null) slot.classList.add("cabin-slot-empty");
  return slot;
}

/** What a set of slots shows, to redraw them only once it changes. */
const signature = (items: Inventory, ...more: unknown[]): string =>
  JSON.stringify([
    items.map((item) =>
      item === null ? null : [item.id, usesLeft(item), item.state],
    ),
    ...more,
  ]);

/**
 * The vehicle's storage, 2x3 slots: click one of its items to take it, or an empty slot to leave
 * the item held there. Under it the local player's own slots: click one to leave its item in the
 * first empty storage slot.
 */
export function storagePanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-storage");
  const title = make("h3", "cabin-title", "CARGO HOLD (2x3)");
  const grid = make("div", "cabin-storage-grid");
  grid.style.gridTemplateColumns = `repeat(${String(STORAGE_COLUMNS)}, 46px)`;
  const caption = make("p", "cabin-caption", "your pockets ↓ click to stow");
  const pockets = make("div", "cabin-pockets");
  element.append(title, grid, caption, pockets);
  let shown = "";
  return {
    element,
    update(view, game: Session) {
      const stored = cabinStorage(game, view.vehicle);
      element.hidden = stored === null;
      if (stored === null) return;
      const { inventory, held } = game.local;
      const signed = signature(stored, signature(inventory), held);
      if (signed === shown) return;
      shown = signed;
      const room = inventory.includes(null);
      const space = stored.includes(null);
      const holding = held === null ? null : (inventory[held] ?? null);
      grid.replaceChildren(
        ...stored.map((item, slot) => {
          const cell = slotButton(
            "cabin-slot",
            item,
            "empty: click to stow what you hold",
            () => {
              if (item !== null) send({ unstow: slot });
              else if (held !== null) send({ stow: held, into: slot });
            },
          );
          cell.disabled = item === null ? holding === null : !room;
          return cell;
        }),
      );
      pockets.replaceChildren(
        ...inventory.map((item, slot) => {
          const pocket = slotButton("cabin-pocket", item, "", () => {
            send({ stow: slot });
          });
          pocket.disabled = item === null || !space;
          if (slot === held) pocket.classList.add("cabin-pocket-held");
          return pocket;
        }),
      );
    },
  };
}

/** The tag a ware on sale wears: how much is off it. */
export const saleTag = (off: number): string => `-${String(off)}%`;

/**
 * The vehicle's shop: what it sells and for how much, greyed out what the team cannot afford; a
 * ware on sale shows its old price struck out and a tag of how much is off.
 */
export function shopPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-shop");
  const title = make("h3", "cabin-title", "$CRAP-MART™ (no refunds)");
  const funds = make("p", "cabin-caption");
  const wares = make("ul", "cabin-wares");
  element.append(title, funds, wares);
  let shown = "";
  return {
    element,
    update(view, game: Session) {
      const shop = cabinShop(game, view.vehicle);
      element.hidden = shop === null;
      if (shop === null) return;
      const signed = JSON.stringify(shop);
      if (signed === shown) return;
      shown = signed;
      funds.textContent = `team credit: ${creditText(shop.credit)}`;
      wares.replaceChildren(
        ...shop.wares.map((ware) => {
          const definition = game.itemDefinitions.get(ware.item);
          const name = definition?.name ?? ware.item;
          const row = make("li", "cabin-ware");
          const buy = button("cabin-buy", "", () => {
            send({ buy: ware.item });
          });
          buy.append(
            make(
              "span",
              "cabin-buy-name",
              `${definition?.emoji ?? "?"} ${name}`,
            ),
            make("span", "cabin-buy-dots"),
            ...(ware.off > 0
              ? [
                  make("span", "cabin-buy-was", creditText(ware.was)),
                  make("span", "cabin-sale-tag", saleTag(ware.off)),
                ]
              : []),
            make("span", "cabin-buy-price", creditText(ware.price)),
          );
          if (ware.off > 0) buy.classList.add("cabin-on-sale");
          const afford = shop.credit >= ware.price;
          buy.disabled = !afford || definition === undefined;
          buy.title = afford ? `Buy a ${name}` : "Can't afford it";
          row.append(buy);
          return row;
        }),
      );
    },
  };
}
