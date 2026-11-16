import { carriedWeight, glyphOf, isOn, usesLeft } from "../sim/index.js";
import type { CarriedItem, HeldSlot, Inventory } from "../sim/index.js";

/** How the toolbar shows items. */
export interface HudConfig {
  /** Most uses an item may have for its bar to show each use as a segment; past it, one bar. */
  readonly segmentsUpTo: number;
}

/** What the toolbar shows while in a room. */
export interface HudState {
  readonly inventory: Inventory;
  readonly held: HeldSlot;
  /** The team's credit. */
  readonly credit: number;
  /** Whether the local player has escaped. */
  readonly escaped: boolean;
  /** Seconds until the cruiser leaves the exit, while it waits there; null otherwise. */
  readonly departingIn: number | null;
}

/** An item's uses as its slot shows them: a bar of what is left, and "left/max". */
interface UsesView {
  readonly text: string;
  /** How full the bar is, 0..1. */
  readonly fill: number;
  /** How many segments the bar is split into; null for one whole bar. */
  readonly segments: number | null;
}

/**
 * One slot of the toolbar: its key number, and its item's glyph, name, weight and uses, blank
 * when empty.
 */
interface SlotView {
  readonly number: string;
  readonly glyph: string;
  /** The colour its glyph glows in, or null for an item that does not glint. */
  readonly glint: string | null;
  readonly name: string;
  readonly weight: string;
  /** Null for an empty slot, or an item whose uses are unlimited. */
  readonly uses: UsesView | null;
  readonly selected: boolean;
  /** Whether its item is switched on. */
  readonly on: boolean;
}

/** Pounds as the toolbar shows them, e.g. "15 lb". */
export const weightText = (pounds: number): string =>
  `${String(Math.round(pounds))} lb`;

function usesView(item: CarriedItem, config: HudConfig): UsesView | null {
  const left = usesLeft(item);
  const max = item.uses;
  if (left === null || max === undefined || max <= 0) return null;
  return {
    text: `${String(left)}/${String(max)}`,
    fill: Math.min(1, left / max),
    segments: max <= config.segmentsUpTo ? max : null,
  };
}

/** Each inventory slot as the toolbar shows it. */
export function slotViews(
  inventory: Inventory,
  held: HeldSlot,
  config: HudConfig,
): SlotView[] {
  return inventory.map((item, index) => ({
    number: String(index + 1),
    glyph: item === null ? "" : glyphOf(item, item.state),
    glint: item?.glint ?? null,
    name: item?.name ?? "",
    weight:
      item?.weight === undefined || item.weight <= 0
        ? ""
        : weightText(item.weight),
    uses: item === null ? null : usesView(item, config),
    selected: index === held,
    on: isOn(item?.state),
  }));
}

export function creditText(credit: number): string {
  return `${String(credit)}$`;
}

/**
 * What the departure shows: that the local player escaped, else a countdown to the cruiser leaving
 * the exit, in whole seconds rounded up, else nothing.
 */
export function departureText(
  escaped: boolean,
  departingIn: number | null,
): string {
  if (escaped) return "Escaped";
  if (departingIn === null) return "";
  return `Leaving in ${String(Math.ceil(departingIn))}s`;
}

interface HudElements {
  readonly bar: Pick<HTMLElement, "hidden">;
  readonly slots: Pick<HTMLOListElement, "replaceChildren">;
  readonly credit: Pick<HTMLElement, "textContent">;
  /** What everything carried weighs together. */
  readonly weight: Pick<HTMLElement, "textContent">;
  readonly departure: Pick<HTMLElement, "textContent">;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

/** A bar of what is left of an item's uses, split into a segment per use when they are few. */
function usesElement(uses: UsesView): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "hud-uses";
  bar.title = `${uses.text} uses left`;
  const track = document.createElement("div");
  track.className = "hud-uses-track";
  if (uses.segments === null) {
    const fill = document.createElement("div");
    fill.className = "hud-uses-fill";
    fill.style.width = `${String(uses.fill * 100)}%`;
    track.append(fill);
  } else {
    const filled = Math.round(uses.fill * uses.segments);
    for (let index = 0; index < uses.segments; index++) {
      const segment = document.createElement("div");
      segment.className = "hud-uses-segment";
      segment.classList.toggle("filled", index < filled);
      track.append(segment);
    }
  }
  bar.append(track, span("hud-uses-text", uses.text));
  return bar;
}

function slotElement(view: SlotView): HTMLLIElement {
  const slot = document.createElement("li");
  slot.className = "hud-slot";
  slot.classList.toggle("selected", view.selected);
  slot.classList.toggle("on", view.on);
  const glyph = span("hud-slot-glyph", view.glyph);
  if (view.glint !== null)
    glyph.style.textShadow = `0 0 6px ${view.glint}, 0 0 2px ${view.glint}`;
  slot.append(
    span("slot-number", view.number),
    glyph,
    span("hud-slot-name", view.name),
    span("hud-slot-weight", view.weight),
  );
  if (view.uses !== null) slot.append(usesElement(view.uses));
  return slot;
}

/**
 * The bottom toolbar: every inventory slot, the held one highlighted, with each item's weight and
 * uses left; what everything carried weighs together, the team's credit beside them, and the
 * departure's countdown, or that the local player escaped. Shown while in a room; hidden by
 * showing null.
 */
export function createHud(elements: HudElements, config: HudConfig) {
  let shownSlots = "";
  let shownCredit = "";
  let shownWeight = "";
  let shownDeparture = "";
  return {
    show(state: HudState | null): void {
      elements.bar.hidden = state === null;
      if (state === null) return;
      const views = slotViews(state.inventory, state.held, config);
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
      const weight = weightText(carriedWeight(state.inventory));
      if (weight !== shownWeight) {
        shownWeight = weight;
        elements.weight.textContent = weight;
      }
      const departure = departureText(state.escaped, state.departingIn);
      if (departure !== shownDeparture) {
        shownDeparture = departure;
        elements.departure.textContent = departure;
      }
    },
  };
}
