import { Relation } from "./config.js";

export function compareRank(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.scoredAt !== b.scoredAt) return a.scoredAt - b.scoredAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function relationTo(viewer, other) {
  if (viewer.id === other.id) return Relation.SELF;
  return compareRank(other, viewer) < 0 ? Relation.ABOVE : Relation.BELOW;
}

export function topRankedPlayer(players) {
  return [...players.values()].sort(compareRank)[0] ?? null;
}

export function rankOf(players, id) {
  return [...players.values()].sort(compareRank).findIndex((player) => player.id === id);
}

export function displayRelation(viewer, other) {
  if (viewer.id !== other.id && other.classNet?.disguised) return Relation.BELOW;
  return relationTo(viewer, other);
}
