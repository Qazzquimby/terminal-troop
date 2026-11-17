import { cabinDoor } from "../sim/index.js";
import type { CabinDoor } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel, CabinSend } from "./cabin.js";

/** What the door's button says, given the door as the cabin has it. */
export function doorLabel(door: CabinDoor): string {
  if (door.closed) return "OPEN DOOR";
  return door.canClose ? "SHUT DOOR" : "LOW POWER";
}

/** What the door panel says under its meter: whether the world can get at those inside. */
export const doorCaption = (door: CabinDoor): string =>
  door.closed ? "sealed: nothing gets in" : "OPEN: you can be seen + hurt";

/** The door: a button that opens or shuts it, and a meter of the power that keeps it shut. */
export function doorPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-door");
  const title = make("h3", "cabin-title", "DOOR (blast-rated)");
  const swing = button("cabin-door-button", "", () => {
    send("door");
  });
  const meter = make("div", "cabin-door-meter");
  const fill = make("div", "cabin-door-fill");
  meter.append(fill);
  const caption = make("p", "cabin-caption");
  element.append(title, swing, meter, caption);
  return {
    element,
    update(view, game) {
      const door = cabinDoor(game, view.vehicle);
      element.hidden = door === null;
      if (door === null) return;
      const label = doorLabel(door);
      if (swing.textContent !== label) swing.textContent = label;
      swing.disabled = !door.closed && !door.canClose;
      element.classList.toggle("cabin-door-shut", door.closed);
      fill.style.width = `${String(Math.round(door.charge * 100))}%`;
      const text = doorCaption(door);
      if (caption.textContent !== text) caption.textContent = text;
    },
  };
}
