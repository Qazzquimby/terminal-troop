import { RANK_FLASH_S } from "./config.js";
import { relationTo, compareRank } from "./ranking.js";

export function createRankTracker() {
  return new Map();
}

export function computeStandings(players, tracker, localId, now) {
  const localPlayer = players.get(localId);
  const sorted = [...players.values()].sort(compareRank);

  const rows = sorted.map((player, index) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    rank: index + 1,
    delta: 0,
    relation: localPlayer ? relationTo(localPlayer, player) : undefined,
  }));

  for (const row of rows) {
    const previous = tracker.get(row.id);
    if (!previous) {
      tracker.set(row.id, { rank: row.rank, delta: 0, flashUntil: 0 });
    } else if (previous.rank !== row.rank) {
      tracker.set(row.id, {
        rank: row.rank,
        delta: previous.rank - row.rank,
        flashUntil: now + RANK_FLASH_S * 1000,
      });
    }

    const entry = tracker.get(row.id);
    if (entry.flashUntil > now) row.delta = entry.delta;
  }

  const displayedIds = new Set(rows.map((row) => row.id));
  for (const id of tracker.keys()) {
    if (!displayedIds.has(id)) tracker.delete(id);
  }

  return rows;
}
