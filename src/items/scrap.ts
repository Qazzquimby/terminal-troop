import type { ItemDefinition } from "../sim/index.js";
import dropUrl from "./sfx/scrap/drop.mp3";
import cashoutUrl from "./sfx/scrap/cashout.mp3";

export interface ScrapConfig {
  /** Credits a single scrap cashes out for. */
  readonly value: number;
  readonly cashoutVolume: number;
}

export const SCRAP = {
  id: "scrap",
  name: "Scrap",
  maxStack: 1,
  emoji: "🔩",
} as const satisfies ItemDefinition;

export const SCRAP_SOUNDS = { cashout: cashoutUrl, drop: dropUrl } as const;
