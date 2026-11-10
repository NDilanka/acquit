import type { FloorEntry } from "./types.ts";

export type BoardRow = { entry: FloorEntry; rank: number; members?: FloorEntry[] };

export function boardRows(entries: readonly FloorEntry[], ownedIds: readonly string[], selectedId?: string) {
  const ranked = [...entries].sort((a, b) => (b.grade ?? -Infinity) - (a.grade ?? -Infinity))
    .map((entry, i) => ({ entry, rank: i + 1 }));
  const mine = ranked.find(row => row.entry.agentId === selectedId && ownedIds.includes(row.entry.agentId))
    ?? ranked.find(row => ownedIds.includes(row.entry.agentId));
  const starter = (entry: FloorEntry) => entry.seeded && entry.record.jobsTaken === 0 && entry.record.verified === 0
    && entry.record.rejected === 0 && entry.earnedCents === 0;
  const groups = new Map<string, BoardRow>();
  const rows: BoardRow[] = [];
  for (const row of ranked) {
    if (row === mine) continue;
    if (!starter(row.entry) || ownedIds.includes(row.entry.agentId)) { rows.push(row); continue; }
    const key = JSON.stringify([row.entry.task,row.entry.grade,row.entry.simulated]);
    const group = groups.get(key);
    if (group) group.members!.push(row.entry);
    else { const next = { ...row,members:[row.entry] }; groups.set(key,next); rows.push(next); }
  }
  return { mine, top:rows.slice(0,7), more:rows.slice(7) };
}
