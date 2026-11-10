/** Presentation of stored owner activity; no synthetic jobs, timestamps or payouts. */
import type { ActivityJob, ActivityState, ActivityTally, OwnerActivity, ReleaseAuthority } from "./types.ts";
import { dollars, reasonSentences } from "./view.ts";
import type { WorkLane } from "./work.ts";

const STATES: Record<ActivityState, string> = {
  BID_PLACED: "Bid placed · awaiting client acceptance",
  FUNDING: "Chosen · waiting for client funding",
  MONEY_HELD: "Money held · waiting for delivery",
  RETRYING: "Rejected · waiting for another delivery",
  VERIFYING: "Delivered · verifier running",
  REFUNDING: "Refund pending",
  AWAITING_APPROVAL: "Verified · awaiting client approval",
  DISPUTED: "Verified · in dispute",
  RELEASING: "Release in progress",
  RELEASED: "Released",
  REFUNDED: "Refunded",
  CLOSED: "Closed without acceptance",
};
const AUTHORITIES: Record<ReleaseAuthority, string> = {
  CLIENT_APPROVAL: "Client approval",
  REVIEW_SILENCE: "Review period ended without a client response",
  ARBITER_UPHELD: "Arbiter upheld the verification",
  ARBITER_SLA_MISSED: "Arbiter response deadline passed",
  CAPTURE_CUTOFF: "Capture cutoff rule",
};

export function activityStateWords(state: ActivityState): string { return STATES[state]; }
export function sampleActivityLabel(job: ActivityJob): string | null {
  return job.source === "SAMPLE_RUNNER" && job.simulated ? job.label : null;
}
export function tallyWords(label: string, tally: ActivityTally | null): string[] {
  return tally === null ? [] : [`${label} ${tally.passed} of ${tally.expected}`];
}
export function runnerStatusWords(runner: OwnerActivity["runner"]): string {
  switch (runner.status) {
    case "OFF": return "Sample runner is off";
    case "IDLE": return "Nothing queued";
    case "QUEUED": return "Waiting for a free runner";
    case "RUNNING": return "Sample runner is running";
    case "REFUSED":
      switch (runner.reason) {
        case "NO_FORK": return "Connect a fork to use the sample runner";
        case "DAILY_LIMIT": return "Hosted run limit reached";
        case "NO_ACQUITTAL": return "Pass a code exam to use the sample runner";
        case "NO_STANDING_ORDERS": return "Save standing orders to use the sample runner";
        default: return "Sample runner cannot start";
      }
  }
}

export type ActivityEvent = { id: string; at: string; title: string; details: readonly string[]; rejected?: boolean };

/** Every event has a stored time. Holding funds never creates an invented acceptance event. */
export function activityEvents(job: ActivityJob, labels: OwnerActivity["labels"]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  if (job.bid) events.push({ id:job.bid.id,at:job.bid.placedAt,title:`Bid placed · ${dollars(job.bid.priceCents)} pending · ${labels.money}`,details:[] });
  if (job.moneyHeld) events.push({ id:"held",at:job.moneyHeld.heldAt,title:`Money held · ${dollars(job.moneyHeld.heldCents)} held · ${labels.money}`,details:[] });
  for (const attempt of job.attempts) events.push({
    id:`attempt-${attempt.ordinal}`,at:attempt.at,rejected:attempt.result === "REJECTED",
    title:`Attempt ${attempt.ordinal} · ${attempt.result === "VERIFIED" ? "Verified" : attempt.result === "REJECTED" ? "Rejected" : "Verdict recorded"} · ${labels.verifier}`,
    details:[...tallyWords("Frozen",attempt.frozen),...tallyWords("Hidden",attempt.hidden),
      ...reasonSentences(attempt.reasons.map(reason => reason.split(":")[0]!))],
  });
  if (job.release) events.push({ id:"release",at:job.release.at,
    title:`${job.release.payoutCents === null ? "Payment released" : `${dollars(job.release.payoutCents)} released`} · ${labels.money}`,
    details:[AUTHORITIES[job.release.authority]],
  });
  return events.sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
}

export function activityLanes(jobs: readonly ActivityJob[], labels: OwnerActivity["labels"]): WorkLane[] {
  return jobs.map(job => ({
    id:job.jobId,label:`${job.title} · ${activityStateWords(job.state)}`,
    start:activityEvents(job,labels)[0]?.at ?? job.updatedAt,end:job.updatedAt,
    tone:job.state === "RELEASED" ? "ok" : job.state === "RETRYING" ? "fail" : "open",
  }));
}
export function activityDomId(jobId: string): string { return `activity-${jobId}`; }
export function activityJobHref(jobId: string): string { return `/specialists/activity?job=${encodeURIComponent(jobId)}`; }
export function releasedWorkHref(jobId: string, feed: OwnerActivity | null | undefined): string {
  return feed?.activity.some(job => job.jobId === jobId) ? activityJobHref(jobId) : `/jobs/${encodeURIComponent(jobId)}`;
}
