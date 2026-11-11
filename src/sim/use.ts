/**
 * An item use in progress, drawn above the player. Local-only, never sent over the network:
 * the item behaviour that starts the use supplies `draw`, so the core stays item-agnostic.
 */
export interface ItemUse {
  readonly startedAt: number;
  readonly endsAt: number;
  /** Draws the use at `now`; does nothing once it has finished. */
  readonly draw: (ctx: CanvasRenderingContext2D, now: number) => void;
}
