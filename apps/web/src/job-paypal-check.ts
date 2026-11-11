import { useEffect, useRef, useState } from "react";
import { api, type CallOptions } from "./api.ts";
import type { JobPayPalCheck, JobView } from "./api-types.ts";
import { allBids } from "./bids.ts";
import { usd } from "./format.ts";
import type { Viewer } from "./job-timeline.ts";

/**
 * PayPal's recorded check of a held payment, in one plain line. It shows the stored amount and a short order
 * reference only; PayPal's status names stay off the page. Null while no check is recorded.
 */
export function payPalCheckLine(check: JobPayPalCheck | null): string | null {
  if (check === null) return null;
  const order = `order ${check.orderId.slice(0, 3)}…`;
  const claim = check.outcome === "HELD" ? `PayPal confirms ${heldWords(check)} is held`
    : check.outcome === "NOT_HELD" ? "PayPal does not confirm this money is held"
    : "PayPal's check is unavailable";
  return `${claim} · ${order} · PayPal sandbox`;
}

function heldWords(check: JobPayPalCheck): string {
  if (check.heldValue === null || check.heldCurrency === null) return "this money";
  if (check.heldCurrency !== "USD") return `${check.heldCurrency} ${check.heldValue}`;
  const cents = Math.round(Number(check.heldValue) * 100);
  return Number.isFinite(cents) ? usd(cents) : "this money";
}

/**
 * Whether the page asks for the check now. The route allows the owning client and the operators who bid, and only
 * while money is held. Signed-out viewers ask for nothing.
 */
export function wantsPayPalCheck(job: Pick<JobView, "client" | "bids" | "ledger">, viewer: Viewer | null): boolean {
  if (viewer === null || !job.ledger.some((line) => line.kind === "HELD")) return false;
  if (viewer.role === "CLIENT") return job.client === viewer.handle;
  return viewer.role === "OPERATOR" && allBids(job).some((bid) => bid.handle === viewer.handle);
}

/** The stored check, or null. A pending check, a refused read, and a failed read all leave nothing to show. */
export async function readJobPayPalCheck(jobId: string, init?: CallOptions): Promise<JobPayPalCheck | null> {
  try {
    return (await api.jobPayPalCheck(jobId, init)).check;
  } catch {
    return null;
  }
}

/**
 * The check the job page shows. The server answers nothing while PayPal's read is still running, so the page asks
 * again on each refresh until a record arrives, then stops. The page never waits on this read.
 */
export function usePayPalCheck(job: JobView | null, viewer: Viewer | null): JobPayPalCheck | null {
  const [found, setFound] = useState<{ readonly jobId: string; readonly check: JobPayPalCheck } | null>(null);
  // The job whose read is in flight, so refreshes of that job do not stack a second read.
  const reading = useRef<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  const shown = job !== null && found?.jobId === job.id ? found.check : null;
  // Only the role and handle decide the read, so a new viewer object for the same person asks nothing new.
  const role = viewer?.role ?? null;
  const handle = viewer?.handle ?? null;
  useEffect(() => () => stop.current?.abort(), []);
  useEffect(() => {
    const who = role === null || handle === null ? null : { role, handle };
    if (job === null || shown !== null || reading.current === job.id || !wantsPayPalCheck(job, who)) return;
    const jobId = job.id;
    const controller = new AbortController();
    stop.current = controller;
    reading.current = jobId;
    void readJobPayPalCheck(jobId, { signal: controller.signal }).then((check) => {
      if (reading.current === jobId) reading.current = null;
      if (check !== null) setFound({ jobId, check });
    });
  }, [job, shown, role, handle]);
  return shown;
}
