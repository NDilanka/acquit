import type { JobView } from "./api-types";
import { ApiError } from "./api.ts";
import { refusalText } from "./format.ts";
import type { Session } from "./session.tsx";

export function errorText(e: unknown): string {
  return e instanceof ApiError ? refusalText(e.code, e.detail) : `Cannot reach the API: ${String(e)}. Retry is safe.`;
}

/** The judge-mode controls a job page may show. Both stay hidden on a job the caller's demo does not own. */
export type DemoControls = { readonly funding: boolean; readonly clock: boolean };

const NONE: DemoControls = { funding: false, clock: false };

/** Only the visitor's own client may fund or move the clock; the API refuses its operator with NOT_VISITOR_JOB. */
export function demoControls(job: Pick<JobView, "client" | "status" | "phase">, session: Pick<Session, "user" | "visitor">): DemoControls {
  const { user, visitor } = session;
  if (!visitor || user.handle !== visitor.client || job.client !== user.handle) return NONE;
  return {
    funding: job.status === "OPEN" && job.phase === "BIDDING",
    clock: job.status === "OPEN" || job.status === "IN_PROGRESS" || job.status === "VERIFIED",
  };
}

export const CLOCK_STEPS = [
  { label: "Advance 1 hour", ms: 3_600_000 },
  { label: "Advance 1 day", ms: 86_400_000 },
  { label: "Advance 3 days", ms: 3 * 86_400_000 },
] as const;

/**
 * JOB_CHANGED means the shift lost its compare-and-set and moved nothing, so sending it again is safe.
 * Any other refusal, or the last JOB_CHANGED, reaches the caller.
 */
export async function withJobChangedRetry<T>(send: () => Promise<T>, attempts = 3): Promise<T> {
  for (let left = attempts; ; left--) {
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "JOB_CHANGED") || left <= 1) throw e;
    }
  }
}

export function clockAhead(shiftMs: number): string {
  const days = Math.floor(shiftMs / 86_400_000);
  const hours = Math.floor((shiftMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((shiftMs % 3_600_000) / 60_000);
  const parts = [
    days > 0 && (days === 1 ? "1 day" : `${days} days`),
    hours > 0 && (hours === 1 ? "1 hour" : `${hours} hours`),
    days === 0 && hours === 0 && minutes > 0 && `${minutes} min`,
  ].filter(Boolean);
  return parts.length ? `This job's clock is ${parts.join(" ")} ahead.` : "This job's clock runs on real time.";
}

export function demoEnds(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return "This demo has ended.";
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  return `Ends in ${hours} h ${minutes} min`;
}
