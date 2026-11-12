import { ACTIONS, keysLabel } from "../input/index.js";
import type { Action, Bindings } from "../input/index.js";

/** One hint entry: the actions whose keys are shown, and the words after them. */
export interface HintEntry {
  readonly actions: readonly Action[];
  readonly does: string;
}

/** What the controls hint shows, in order. Adding or removing a control is one line. */
export const CONTROLS_HINT: readonly HintEntry[] = [
  { actions: ["moveUp", "moveLeft", "moveDown", "moveRight"], does: "to move" },
  { actions: ["sprint"], does: "to sprint" },
  { actions: ["crouch"], does: "to toggle crouch" },
  { actions: ["secondary"], does: "to kick" },
  { actions: ["toggleInventory"], does: "to toggle inventory" },
  { actions: ["toggleSettings"], does: "for settings" },
];

/** Shown after the hint while push to talk is on. */
export const TALK_HINT: HintEntry = {
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
