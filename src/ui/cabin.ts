import { driverOf, occupantsOf, vehicleOf } from "../sim/index.js";
import type { CabinCommand, Session } from "../sim/index.js";

/*
 * The cabin: what a player inside a vehicle, off its wheel, sees, a modal over most of the game.
 * It is ugly and awkward on purpose. It is a frame of panels: each panel is an element of its own
 * with an `update` that the cabin runs on every frame it shows, given what the cabin shows and
 * the session. A panel asks the vehicle for something through `send`, which the game runs as part
 * of its next step, so it goes through the actions framework like any other control. Panels are
 * added with `addPanel`, in the order they are laid out.
 */

/** Someone inside the vehicle, as the cabin lists them. */
interface Occupant {
  readonly id: string;
  readonly name: string;
  /** Whether they have the wheel. */
  readonly driving: boolean;
  /** Whether they are the local player. */
  readonly self: boolean;
}

/** What the cabin shows: who is inside, who drives, how the wheel is turned. */
export interface CabinView {
  /** The vehicle's entity id. */
  readonly vehicle: string;
  readonly occupants: readonly Occupant[];
  /** The name of whoever has the wheel; null for no one. */
  readonly driver: string | null;
  /** How far the wheel is turned, -1 to 1, right positive. */
  readonly turn: number;
  /** Whether the local player may take the wheel now. */
  readonly canDrive: boolean;
}

/**
 * What the cabin shows the local player: null unless it is inside a vehicle, off its wheel. The
 * wheel turns as its driver turns it; with no driver it stands straight.
 */
export function cabinView(game: Session): CabinView | null {
  const { ride } = game.local;
  if (ride === null || ride.driving) return null;
  if (vehicleOf(game, ride.vehicle) === null) return null;
  const driver = driverOf(game, ride.vehicle);
  return {
    vehicle: ride.vehicle,
    occupants: occupantsOf(game, ride.vehicle).map((player) => ({
      id: player.id,
      name: player.name,
      driving: player.ride?.driving === true,
      self: player === game.local,
    })),
    driver: driver?.name ?? null,
    turn: driver?.ride?.turn ?? 0,
    canDrive: driver === null,
  };
}

/** One panel of the cabin: its element, and how it follows what the cabin shows. */
export interface CabinPanel {
  readonly element: HTMLElement;
  /** Runs on every frame the cabin shows, with what it shows and the session it shows it from. */
  update?(view: CabinView, game: Session): void;
}

/** Asks the vehicle the local player is in for `command`, in the game's next step. */
type CabinSend = (command: CabinCommand) => void;

/** Degrees the drawn wheel turns at full lock. */
const FULL_LOCK = 120;

/** Milliseconds the honk's "HONK!" stays up. */
const HONK_SHOWN_MS = 450;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

/**
 * A button that runs `click` and lets go of focus once clicked, so the keys go on reaching the
 * game: Space on a focused button would press it again.
 */
function button(className: string, text: string, click: () => void) {
  const element = make("button", className, text);
  element.type = "button";
  element.tabIndex = -1;
  element.addEventListener("click", () => {
    element.blur();
    click();
  });
  return element;
}

const SVG = "http://www.w3.org/2000/svg";

/** A steering wheel drawn as an SVG: rim, three spokes and a hub with a horn mark. */
function wheelSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "-50 -50 100 100");
  svg.setAttribute("class", "cabin-wheel-svg");
  const shape = (tag: string, attributes: Record<string, string>) => {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes))
      element.setAttribute(name, value);
    svg.append(element);
  };
  shape("circle", { r: "42", class: "cabin-wheel-rim" });
  for (const angle of [90, 210, 330]) {
    const radians = (angle * Math.PI) / 180;
    shape("line", {
      x1: "0",
      y1: "0",
      x2: String(Math.cos(radians) * 40),
      y2: String(Math.sin(radians) * 40),
      class: "cabin-wheel-spoke",
    });
  }
  shape("circle", { r: "13", class: "cabin-wheel-hub" });
  shape("rect", {
    x: "-4",
    y: "-46",
    width: "8",
    height: "10",
    class: "cabin-wheel-mark",
  });
  return svg;
}

/** The steering wheel, turning as the vehicle's driver turns it, and who drives. */
function wheelPanel(): CabinPanel {
  const element = make("section", "cabin-panel cabin-wheel");
  const title = make("h3", "cabin-title", "STEERING (wheel)");
  const svg = wheelSvg();
  const caption = make("p", "cabin-caption");
  element.append(title, svg, caption);
  return {
    element,
    update(view) {
      svg.style.transform = `rotate(${String(view.turn * FULL_LOCK)}deg)`;
      const text =
        view.driver === null
          ? "nobody is driving!!"
          : `${view.driver} has the wheel`;
      if (caption.textContent !== text) caption.textContent = text;
    },
  };
}

/** The Drive and Honk buttons. */
function controlsPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-controls");
  const honked = make("p", "cabin-honked", "HONK!");
  honked.hidden = true;
  let hideHonk: ReturnType<typeof setTimeout> | null = null;
  const drive = button("cabin-drive", "DRIVE ▶", () => {
    send("drive");
  });
  const honk = button("cabin-honk", "honk", () => {
    send("honk");
    honked.hidden = false;
    if (hideHonk !== null) clearTimeout(hideHonk);
    hideHonk = setTimeout(() => {
      honked.hidden = true;
    }, HONK_SHOWN_MS);
  });
  element.append(drive, honk, honked);
  return {
    element,
    update(view) {
      drive.disabled = !view.canDrive;
      drive.title = view.canDrive ? "" : "Someone else has the wheel";
    },
  };
}

/** Who is inside, the local player and the driver marked. */
function occupantsPanel(): CabinPanel {
  const element = make("section", "cabin-panel cabin-occupants");
  const title = make("h3", "cabin-title", "PASSENGER MANIFEST");
  const list = make("ul", "cabin-occupant-list");
  element.append(title, list);
  let shown = "";
  return {
    element,
    update(view) {
      const signature = JSON.stringify(view.occupants);
      if (signature === shown) return;
      shown = signature;
      list.replaceChildren(
        ...view.occupants.map((occupant) => {
          const marks = `${occupant.driving ? " 🛞" : ""}${occupant.self ? " (you)" : ""}`;
          return make("li", "cabin-occupant", `${occupant.name}${marks}`);
        }),
      );
    },
  };
}

/** The cartoony exit sign, which gets the local player out. */
function exitPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-exit-panel");
  const sign = button("cabin-exit", "", () => {
    send("exit");
  });
  sign.title = "Get out";
  sign.append(
    make("span", "cabin-exit-runner", "🏃"),
    make("span", "cabin-exit-word", "EXIT"),
    make("span", "cabin-exit-arrow", "➜"),
  );
  element.append(sign);
  return { element };
}

/**
 * The cabin modal in `root`, holding the panels part of every vehicle's cabin: the wheel, Drive
 * and Honk, who is inside, and the exit sign. Shown while `show` is given a view, hidden by null.
 * More panels go in with `addPanel`.
 */
export function createCabin(root: HTMLElement, send: CabinSend) {
  const header = make("h2", "cabin-header", "~*~ CRUISER CABIN ~*~");
  const panels = make("div", "cabin-panels");
  root.replaceChildren(header, panels);
  root.hidden = true;
  const added: CabinPanel[] = [];
  const addPanel = (panel: CabinPanel): void => {
    added.push(panel);
    panels.append(panel.element);
  };
  for (const panel of [
    wheelPanel(),
    controlsPanel(send),
    occupantsPanel(),
    exitPanel(send),
  ])
    addPanel(panel);
  return {
    addPanel,
    /** Shows the cabin as `view` has it, from `game`; hides it for null. */
    show(view: CabinView | null, game: Session | null): void {
      root.hidden = view === null || game === null;
      if (view === null || game === null) return;
      for (const panel of added) panel.update?.(view, game);
    },
  };
}
