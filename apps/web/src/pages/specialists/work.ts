import type { MorningReport } from "./types.ts";
import { dollars } from "./view.ts";

export type WorkEvent = {
  id: string; at: string; jobId: string | null; agentId: string | null;
  kind: "bid" | "win" | "verified" | "rejected" | "submit" | "released";
  status: string;
};
export type WorkLane = { id: string; label: string; start: string; end: string; tone: "ok" | "fail" | "open" };

export function reportEvents(report: MorningReport): WorkEvent[] {
  const kinds = ["bid", "win", "verified", "rejected", "submit"] as const;
  const lists = [report.bids, report.wins, report.verified, report.rejected, report.preApprovals];
  return lists.flatMap((entries, i) => entries.map((entry, n) => ({
    id: `${kinds[i]}:${entry.jobId ?? ""}:${entry.at}:${n}`,
    at: entry.at, jobId: entry.jobId, agentId: entry.agentId, kind: kinds[i]!,
    status: kinds[i] === "bid" ? entry.amountCents === undefined ? "Bid placed · pending" : `${dollars(entry.amountCents)} pending`
      : kinds[i] === "win" ? "Won · work started"
      : kinds[i] === "verified" ? "Verified · release not confirmed"
      : kinds[i] === "rejected" ? "Rejected"
      : "Submit pre-approved",
  }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function jobLabel(id: string | null): string {
  return id ? `Job ${id.replace(/^job[_-]/, "").slice(0, 8)}` : "Workspace activity";
}

export function groupJobs(events: readonly WorkEvent[]) {
  const jobs = new Map<string, WorkEvent[]>();
  for (const event of events) {
    // Events with no job id remain independent; unrelated work must not be merged.
    const id = event.jobId ?? event.id;
    jobs.set(id, [...(jobs.get(id) ?? []), event]);
  }
  return [...jobs.entries()].map(([id, entries]) => ({
    id, entries: entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  })).sort((a, b) => Date.parse(b.entries[0]!.at) - Date.parse(a.entries[0]!.at));
}

export function jobLanes(events: readonly WorkEvent[]): WorkLane[] {
  return groupJobs(events).map(({ id, entries }) => {
    const latest = entries[0]!;
    return { id, label: `${jobLabel(latest.jobId)} · ${latest.kind === "win" ? "won" : latest.kind}`,
      start: entries.at(-1)!.at, end: latest.at,
      tone: latest.kind === "released" ? "ok" : latest.kind === "rejected" ? "fail" : "open" };
  });
}

export function timeWords(iso: string, full = false): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", { ...(full ? { day: "numeric", month: "short", year: "numeric" } as const : {}),
    hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(/\bam\b/i, "am").replace(/\bpm\b/i, "pm");
}

/** A real timestamp range. Zero-duration bars get a visual minimum, not an invented duration. */
export function stripRange(lanes: readonly WorkLane[], through?: string) {
  const timestamps = lanes.flatMap((lane) => [Date.parse(lane.start), Date.parse(lane.end)]).filter(Number.isFinite);
  if (!timestamps.length) return null;
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps, through ? Date.parse(through) : -Infinity);
  return { start, end, span: Math.max(1, end - start) };
}

export function agentDelta(report: MorningReport | null, agentId?: string): number | undefined {
  return report && agentId ? report.gradeChanges.filter((entry) => entry.agentId === agentId).reduce((sum, entry) => sum + entry.delta, 0) : undefined;
}
