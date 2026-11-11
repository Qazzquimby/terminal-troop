/**
 * Every entity kind, in one ordered list. A kind's number is its position, so two kinds cannot
 * collide and every client numbers them the same way from the same source. Append new kinds;
 * never reorder, since a kind's number is what snapshots carry between clients.
 */
const KINDS = ["chaser", "cruiser"] as const;

export type EntityKind = (typeof KINDS)[number];

/** The number a kind is sent as in snapshots: its position in {@link KINDS}, from 1. */
export function kindId(kind: EntityKind): number {
  return KINDS.indexOf(kind) + 1;
}
