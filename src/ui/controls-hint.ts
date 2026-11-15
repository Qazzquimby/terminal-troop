import { ACTIONS, keysLabel } from "../input/index.js";
import type { Action, Bindings } from "../input/index.js";
import { isGhost } from "../sim/index.js";
import type { Player } from "../sim/index.js";

/** One hint entry: the actions whose keys are shown, and the words after them. */
export interface HintEntry {
  readonly actions: readonly Action[];
  readonly does: string;
}

/** What the local player is doing, which decides the controls it has. */
export type HintMode = "foot" | "cabin" | "driving" | "ghost";

const MOVE: readonly Action[] = ["moveUp", "moveLeft", "moveDown", "moveRight"];
const SETTINGS: HintEntry = {
  actions: ["toggleSettings"],
  does: "for settings",
};

/** What the controls hint shows in each mode, in order. Adding or removing a control is one line. */
export const CONTROLS_HINT: Readonly<Record<HintMode, readonly HintEntry[]>> = {
  foot: [
    { actions: MOVE, does: "to move" },
    { actions: ["sprint"], does: "to sprint" },
    { actions: ["crouch"], does: "to toggle crouch" },
    { actions: ["useItem"], does: "to use" },
    { actions: ["secondary"], does: "to kick" },
    { actions: ["interact"], does: "to pick up / get in / work item" },
    { actions: ["drop"], does: "to drop" },
    { actions: ["slotPrevious", "slotNext"], does: "to switch item" },
    SETTINGS,
  ],
  cabin: [{ actions: ["interact"], does: "to take the wheel" }, SETTINGS],
  driving: [
    { actions: MOVE, does: "to drive" },
    { actions: ["honk"], does: "to honk" },
    { actions: ["interact"], does: "to let go of the wheel" },
    SETTINGS,
  ],
  ghost: [
    { actions: ["useItem"], does: "to watch next" },
    { actions: ["secondary"], does: "to watch previous" },
    { actions: ["toggleView"], does: "to toggle free camera" },
    { actions: MOVE, does: "to move free camera" },
    SETTINGS,
  ],
};

/** Shown after the hint while push to talk is on. */
const TALK_HINT: HintEntry = {
  actions: ["pushToTalk"],
  does: "to talk",
};

/** "<keys> <does>" per entry, joined with " · ". */
export function controlsHintText(
  entries: readonly HintEntry[],
  bindings: Bindings = ACTIONS,
): string {
  return entries
    .map(({ actions, does }) => `${keysLabel(actions, bindings)} ${does}`)
    .join(" · ");
}

/**
 * The mode a player's controls are in: a ghost spectates, a driver drives, one inside a vehicle
 * off its wheel sits in its cabin, else on foot.
 */
export function hintMode(player: Pick<Player, "health" | "ride">): HintMode {
  if (isGhost(player)) return "ghost";
  if (player.ride === null) return "foot";
  return player.ride.driving ? "driving" : "cabin";
}

/** The hint for `mode`, with the talk key when push to talk is on. */
export function controlsHintFor(mode: HintMode, pushToTalk: boolean): string {
  const entries = CONTROLS_HINT[mode];
  return controlsHintText(pushToTalk ? [...entries, TALK_HINT] : entries);
}
