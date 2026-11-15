import { whileHeld } from "../input/index.js";
import { onAir, transceiverOf, vehicleOf } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel, CabinSend } from "./cabin.js";

/**
 * The transmit button of the vehicle's set on the walkie band: held down, it says
 * so through `hold`, and lets go as it is let go. It lights up while the local
 * player is on the air, by this or by its transmit key.
 */
export function transmitPanel(hold: (held: boolean) => void): CabinPanel {
  const element = make("section", "cabin-panel cabin-transmit");
  const title = make("h3", "cabin-title", "C.B. RADIO (walkie band)");
  const talk = make("button", "cabin-transmit-button", "HOLD 2 TALK");
  talk.type = "button";
  talk.tabIndex = -1;
  whileHeld(talk, hold);
  const caption = make("p", "cabin-caption");
  element.append(title, talk, caption);
  return {
    element,
    update(_view, game) {
      const set = transceiverOf(game, game.local) !== null;
      const live = set && onAir.get(game.local);
      talk.disabled = !set;
      talk.classList.toggle("cabin-on-air", live);
      const text = !set
        ? "no set in here"
        : live
          ? "*** ON AIR ***"
          : "hearing every walkie";
      if (caption.textContent !== text) caption.textContent = text;
    },
  };
}

/** The radio: tune to the next station, switching it on, or switch it off. */
export function radioPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-radio");
  const title = make("h3", "cabin-title", "FM RADIOOO");
  const dial = make("p", "cabin-radio-dial");
  const tune = button("cabin-radio-tune", "TUNE ⏭", () => {
    send("radio");
  });
  const off = button("cabin-radio-off", "off", () => {
    send("radioOff");
  });
  element.append(title, dial, tune, off);
  return {
    element,
    update(view, game) {
      const found = vehicleOf(game, view.vehicle);
      const station = found?.spec.station?.(found.entity) ?? null;
      const text =
        station === null ? "~ static ~" : `STATION ${String(station + 1)}`;
      if (dial.textContent !== text) dial.textContent = text;
      off.disabled = station === null;
      tune.disabled = found?.spec.tune === undefined;
    },
  };
}
