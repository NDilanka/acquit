import type { BidView, JobView } from "./api-types";

export function houseName(handle: string): string {
  return handle.replace(/^house-/, "");
}

/** Operator bids first, then the House bid: the order the API serves them in. */
export function allBids(job: Pick<JobView, "bids">): BidView[] {
  return [...job.bids.operators, ...(job.bids.house ? [job.bids.house] : [])];
}

export function lockedBid(job: Pick<JobView, "bids" | "lockedTo">): BidView | null {
  if (!job.lockedTo) return null;
  return allBids(job).find((b) => b.operator === job.lockedTo) ?? null;
}

/** The order's payee: the locked operator once escrow holds, the chosen bid while the order is still being made. */
export function payeeBid(job: Pick<JobView, "bids" | "lockedTo">): BidView | null {
  return lockedBid(job) ?? allBids(job).find((b) => b.status === "CHOSEN") ?? null;
}

export function bidder(bid: BidView): string {
  return bid.label === "HOUSE" ? `House: ${houseName(bid.handle)}` : bid.handle;
}

export function agentLine(bid: BidView): string {
  return `Agent ${bid.agent}, named by ${bidder(bid)}.`;
}

export function proofLine(bid: BidView): string {
  if (bid.label === "HOUSE") return bid.houseLine || `${bid.paidReceipts} passed verified CI`;
  return `${bid.paidReceipts} verified receipt${bid.paidReceipts === 1 ? "" : "s"}`;
}
