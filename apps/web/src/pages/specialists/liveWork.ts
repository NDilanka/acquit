/** Presentation of stored owner activity; no synthetic jobs, timestamps or payouts. */
import type { ActivityJob, ActivityState, ActivityTally, OwnerActivity, ReleaseAuthority } from "./types.ts";
import { dollars, reasonSentences } from "./view.ts";
import type { ActivityHeadline, WorkLane } from "./work.ts";

const STATES: Record<ActivityState, string> = {
  BID_PLACED: "The bid is awaiting client acceptance.",
  FUNDING: "The client chose this bid and is funding it.",
  MONEY_HELD: "Money is held, awaiting delivery.",
  RETRYING: "The delivery was rejected; another attempt is available.",
  VERIFYING: "The real verifier is checking the delivery.",
  REFUNDING: "A refund is pending.",
  AWAITING_APPROVAL: "The work is verified, awaiting client approval.",
  DISPUTED: "The verified work is in dispute.",
  RELEASING: "Payment release is in progress.",
  RELEASED: "Payment was released.",
  REFUNDED: "The payment was refunded.",
  CLOSED: "This job or its sample run is closed.",
};
const AUTHORITIES: Record<ReleaseAuthority, string> = {
  CLIENT_APPROVAL: "Client approval",
  REVIEW_SILENCE: "Review period ended without a client response",
  ARBITER_UPHELD: "Arbiter upheld the verification",
  ARBITER_SLA_MISSED: "Arbiter response deadline passed",
  CAPTURE_CUTOFF: "Capture cutoff rule",
};

export function activityStateWords(state: string): string {
  return Object.hasOwn(STATES,state) ? STATES[state as ActivityState] : "The current job state is unavailable.";
}

/** The selected agent's newest stored job drives the headline, not the autopilot switch. */
export function activitySummary(feed: OwnerActivity | undefined, active: boolean, agentId?: string): ActivityHeadline & { detail: string } {
  if (!feed) return { heading:"Loading activity.",detail:"Reading your jobs and runner state.",earnings:false };
  const latest = [...feed.activity].filter(job => !agentId || job.agentId === agentId)
    .sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (latest?.state === "RELEASED") return {
    heading:latest.release?.payoutCents == null ? "Your agent's payment was released." : `Your agent was paid ${dollars(latest.release.payoutCents)}.`,
    detail:feed.labels.money,earnings:true,moneyLabel:feed.labels.money,
  };
  if (latest?.state === "CLOSED") return {
    heading:closedReasonWords(latest.closedReason) ?? activityStateWords(latest.state),
    detail:closedMoneyWords(latest) ?? "No further delivery is being made on this run.",earnings:active,
  };
  if (feed.runner.status === "REFUSED") return {
    heading:runnerStatusWords(feed.runner),detail:"Review the runner details below.",earnings:active,
  };
  if (latest?.state === "REFUNDED") return {
    heading:activityStateWords(latest.state),detail:"This run has ended.",earnings:active,
  };
  if (latest) return {
    heading:"Your agent is working on a job.",
    detail:activityStateWords(latest.state),earnings:active,
  };
  if (feed.runner.status === "RUNNING") return {
    heading:runnerStatusWords(feed.runner),
    detail:agentId ? "No job has been recorded for this agent yet." : "No job has been recorded yet.",earnings:active,
  };
  return { heading:active ? "You can close this tab now." : "Autopilot is off",
    detail:active ? "Your agent works within your orders." : "No new bids are placed automatically.",earnings:active };
}
/** Translate only documented reason shapes. Never echo error names or refusal payloads. */
export function closedReasonWords(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (/^verifier gave no verdict in \d+ runs$/.test(reason) || /^job is [A-Z_]+ with no verdict for this commit$/.test(reason))
    return "The verifier returned no verdict for this delivery.";
  if (reason === "job is no longer listed") return "The job is no longer available.";
  if (reason === "run has no commit") return "The sample run has no delivery commit.";
  if (/^push failed \([^)]+\)$/.test(reason)) return "The sample runner could not push the delivery.";
  if (/^submit denied: [A-Z_]+$/.test(reason)) return "The delivery submission was declined.";
  if (/^job is [A-Z_]+$/.test(reason)) return "The job left the state needed for this sample run.";
  return "The sample run stopped; no further delivery is being made.";
}
export function closedMoneyWords(job: ActivityJob): string | null {
  return job.state === "CLOSED" && job.moneyHeld
    ? "Delivery has stopped. Money is still held; stopping the runner does not refund or release it."
    : null;
}
export function sampleActivityLabel(job: ActivityJob): string | null {
  return job.source === "SAMPLE_RUNNER" && job.simulated ? job.label : null;
}
export function tallyWords(label: string, tally: ActivityTally | null): string[] {
  return tally === null ? [] : [`${label} ${tally.passed} of ${tally.expected}`];
}
export function runnerStatusWords(runner: OwnerActivity["runner"]): string {
  switch (runner.status) {
    case "OFF": return "The sample runner is off.";
    case "IDLE": return "No sample run is queued.";
    case "QUEUED": return "The sample is waiting for a free runner.";
    case "RUNNING": return "The sample runner is running.";
    case "REFUSED":
      switch (runner.reason) {
        case "NO_FORK": return "Connect a fork before running this sample.";
        case "DAILY_LIMIT": return "This agent has used its hosted run allowance.";
        case "NO_ACQUITTAL": return "Pass the code exam before running this sample.";
        case "NO_STANDING_ORDERS": return "Set Standing orders before running this sample.";
        case "AUTOPILOT_OFF": return "Turn on autopilot in Standing orders to run this sample.";
        case "NOT_HOSTED": return "Choose Acquit under Change limits in Standing orders.";
        case "NOT_A_SAMPLE": return "Hosted runs need a built-in sample agent.";
        case "BID_DENIED": return "The client declined this bid";
        case "PRICE_CANNOT_CARRY_FEE": return "Your price floor is too low to cover PayPal's fee. Raise it in Standing orders.";
        case "DELIVERY_STOPPED": return "Delivery has stopped while money is still held. No new sample bid will be placed until the job leaves delivery.";
        default: return "The sample runner is unavailable for this agent.";
      }
    default: return "The sample runner's current state is unavailable.";
  }
}

export function runnerAction(runner: OwnerActivity["runner"], agentId?: string) {
  if (runner.status !== "REFUSED") return null;
  const suffix = agentId ? `/${encodeURIComponent(agentId)}` : "";
  switch (runner.reason) {
    case "NO_ACQUITTAL": return { to:`/specialists/exam${suffix}`,label:"Take the exam" };
    case "NO_STANDING_ORDERS": case "AUTOPILOT_OFF": case "NOT_HOSTED":
      return { to:`/specialists/orders${suffix}`,label:"Open Standing orders" };
    case "PRICE_CANNOT_CARRY_FEE": return { to:`/specialists/orders${suffix}`,label:"Raise the price floor" };
    case "NOT_A_SAMPLE": return { to:"/specialists",label:"Choose a sample agent" };
    case "DELIVERY_STOPPED": return { to:"/specialists/activity",label:"Review the stopped delivery" };
    default: return null;
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
