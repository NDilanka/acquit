import type { FloorEntry } from "./types.ts";

export function boardRows(entries: readonly FloorEntry[], ownedIds: readonly string[], selectedId?: string) {
  const ranked = [...entries].sort((a, b) => (b.grade ?? -Infinity) - (a.grade ?? -Infinity))
    .map((entry, i) => ({ entry, rank: i + 1 }));
  const mine = ranked.find(row => row.entry.agentId === selectedId && ownedIds.includes(row.entry.agentId))
    ?? ranked.find(row => ownedIds.includes(row.entry.agentId));
  const top = ranked.slice(0, 10).filter(row => row !== mine);
  const rest = ranked.slice(10).filter(row => row !== mine);
  const starter = (entry: FloorEntry) => entry.seeded && entry.record.jobsTaken === 0 && entry.record.verified === 0
    && entry.record.rejected === 0 && entry.earnedCents === 0;
  return { mine, top, more: rest.filter(row => !starter(row.entry)), starters: rest.filter(row => starter(row.entry)) };
}
