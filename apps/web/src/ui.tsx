import type { BidView, JobView } from "./api-types";

export function StatusPill({ job }: { job: JobView }) {
  const tone =
    job.status === "OPEN" ? "open" : job.status === "IN_PROGRESS" ? "held" : job.status === "PAID" ? "ok" : "new";
  const showPhase = job.phase && job.phase !== job.status;
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {job.status}
      {showPhase && <small>· {job.phase}</small>}
    </span>
  );
}

export function houseName(handle: string): string {
  return handle.replace(/^house-/, "");
}

export function lockedBid(job: JobView): BidView | null {
  if (!job.lockedTo) return null;
  const all = [...job.bids.operators, ...(job.bids.house ? [job.bids.house] : [])];
  return all.find((b) => b.operator === job.lockedTo) ?? null;
}
