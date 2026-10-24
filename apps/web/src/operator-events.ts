import type { JobView } from "./api-types";
import { lockedBid } from "./bids.ts";
import { usd } from "./format.ts";

type WatchedJob = Pick<JobView, "id" | "title" | "status" | "phase" | "bids" | "lockedTo" | "receipt" | "release">;

/** A moment the operator hears about by toast. The key names it once, so it is shown once. */
export type OperatorEvent = { readonly key: string; readonly message: string };

/** How often an operator's pages read their jobs for won bids and payments. */
export const WATCH_MS = 5000;

/** Sent on the window when a watched job changed, so an operator page reloads its own reads. */
export const JOBS_CHANGED = "acquit:jobs-changed";

/** The operator's own moments in these jobs: a bid of theirs accepted, and a payment released to them. */
export function operatorEvents(jobs: readonly WatchedJob[], handle: string): OperatorEvent[] {
  const events: OperatorEvent[] = [];
  for (const job of jobs) {
    if (lockedBid(job)?.handle !== handle) continue;
    events.push({ key: `accepted:${job.id}`, message: `Your bid on “${job.title}” was accepted.` });
    const paid = job.status === "PAID" ? (job.receipt?.paid ?? job.release?.paid ?? null) : null;
    if (paid !== null) events.push({ key: `paid:${job.id}`, message: `You were paid ${usd(paid)} for “${job.title}”.` });
  }
  return events;
}

/** Keys kept per operator: enough for every job a sandbox account can hold, so the store never grows without end. */
const SEEN_MAX = 200;

/**
 * The events not seen before, and the seen keys to store. With nothing stored yet, this browser has never watched
 * this operator, so everything already true is marked seen and nothing is toasted.
 */
export function unseenEvents(events: readonly OperatorEvent[], seen: readonly string[] | null): { fresh: OperatorEvent[]; seen: string[] } {
  const known = new Set(seen ?? []);
  const fresh = seen === null ? [] : events.filter((event) => !known.has(event.key));
  const next = [...(seen ?? []), ...events.map((event) => event.key).filter((key) => !known.has(key))];
  return { fresh, seen: next.slice(-SEEN_MAX) };
}

/** The My work badge: jobs locked to this operator that wait on a delivery. */
export function deliveryCount(jobs: readonly WatchedJob[], handle: string): number {
  return jobs.filter((job) => job.status === "IN_PROGRESS" && job.phase === "READY" && lockedBid(job)?.handle === handle).length;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const seenKey = (handle: string) => `acquit.seenEvents.${handle}`;

export function readSeen(store: Store, handle: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(store.getItem(seenKey(handle)) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : null;
  } catch {
    return null;
  }
}

export function writeSeen(store: Store, handle: string, seen: readonly string[]): void {
  try {
    store.setItem(seenKey(handle), JSON.stringify(seen));
  } catch {
    // A store that refuses the write can only repeat a toast; nothing else depends on it.
  }
}
