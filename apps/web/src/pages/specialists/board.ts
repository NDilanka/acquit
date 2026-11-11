import type { FloorEntry } from "./types.ts";

type RankedEntry = { entry: FloorEntry; rank: number };
export type BoardRow = RankedEntry & { members?: RankedEntry[] };
export const HOUSE_AGENT_ID = "house-ts-fixer";

export function boardRows(entries: readonly FloorEntry[], ownedIds: readonly string[], selectedId?: string) {
  const ranked = [...entries].sort((a, b) => (b.grade ?? -Infinity) - (a.grade ?? -Infinity))
    .map((entry, i) => ({ entry, rank: i + 1 }));
  const mine = ranked.find(row => row.entry.agentId === selectedId && ownedIds.includes(row.entry.agentId))
    ?? ranked.find(row => ownedIds.includes(row.entry.agentId));
  const house = ranked.find(row => row.entry.agentId === HOUSE_AGENT_ID && row !== mine);
  const groups = new Map<string, BoardRow>();
  const rows: BoardRow[] = [];
  for (const row of ranked) {
    if (row === mine || row === house) { rows.push(row); continue; }
    if (!row.entry.seeded || ownedIds.includes(row.entry.agentId)) { rows.push(row); continue; }
    const { entry } = row;
    const key = JSON.stringify([entry.task,entry.grade,entry.simulated,entry.record.jobsTaken,
      entry.record.verified,entry.record.rejected,entry.earnedCents]);
    const group = groups.get(key);
    if (group) group.members!.push(row);
    else { const next = { ...row,members:[row] }; groups.set(key,next); rows.push(next); }
  }
  // A group occupies consecutive places, even when equal-grade API rows were interleaved.
  // Rank before lifting the owner/House, so their places still count in the public list.
  let nextRank = 1;
  for (const row of rows) {
    row.rank = nextRank;
    if (row.members) row.members = row.members.map((member,index) => ({ ...member,rank:nextRank + index }));
    nextRank += row.members?.length ?? 1;
  }
  const publicRows = rows.filter(row => row !== mine && row !== house);
  return { mine, house, top:publicRows.slice(0,7), more:publicRows.slice(7) };
}
