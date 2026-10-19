import type { Attempt, JobView, VerifierFields } from "./api-types";
import { allBids, bidder, lockedBid, proofLine } from "./bids.ts";
import { arbiterNoteLine, authorityNote, eta, mergeNote, refundNote, usd, utc } from "./format.ts";
import { bidStatusWord, stateKey, type StateKey, type StatusTone } from "./job-status.ts";
import { tallyWords } from "./receipt-view.ts";
import { seededLabel } from "./scoping-review.ts";

/** The job view as the page holds it: the mirrored JobView plus the attempt history the projection serves. */
export type TimelineJob = JobView & VerifierFields;

export type Viewer = { readonly role: "CLIENT" | "OPERATOR" | "PLATFORM"; readonly handle: string };

export type TimelineKind = "CONTRACT" | "BID" | "HELD" | "ATTEMPT" | "ARBITER" | "REVIEW" | "DISPUTE" | "PAYOUT" | "REFUND" | "RECEIPT";

/** An id shown as a copyable chip. The label, when present, names what the id is. */
export type TimelineId = { readonly value: string; readonly label?: string };

export type TimelineEvent = {
  /** Null when the job view serves no time for the event. Bids carry none. */
  readonly at: string | null;
  readonly kind: TimelineKind;
  readonly title: string;
  readonly detail: string;
  readonly tone: StatusTone;
  /** Ids shown as copyable chips: the frozen commit, the hidden-case digest, commits, PayPal ids, the receipt id. */
  readonly ids: readonly TimelineId[];
  /** The pull request that carries an attempt or the receipt. Null when there is none to link. */
  readonly href: string | null;
};

export type MoneyRow = {
  readonly key: "HELD" | "RELEASED" | "REFUND" | "FEE";
  readonly label: string;
  /** Null when the ledger holds no line of this kind yet. */
  readonly cents: number | null;
  readonly note: string | null;
};

/** Who the viewer is to this job. A locked operator is the one who delivers. */
type Seat = "CLIENT" | "LOCKED" | "BIDDER" | "OTHER";

function seatOf(job: TimelineJob, viewer: Viewer): Seat {
  // The projection names the owning client only to that client, so another client reads as an observer.
  if (viewer.role === "CLIENT") return job.client === viewer.handle ? "CLIENT" : "OTHER";
  if (viewer.role === "OPERATOR" && lockedBid(job)?.handle === viewer.handle) return "LOCKED";
  if (allBids(job).some((b) => b.handle === viewer.handle)) return "BIDDER";
  return "OTHER";
}

/** The events in lifecycle order. Bids carry no time, so they sit between the contract and the held payment. */
export function timelineEvents(job: TimelineJob): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const total = job.attempts.used + job.attempts.left;
  const operator = lockedBid(job)?.handle ?? "the operator";
  const repository = job.contract?.repository ?? null;
  const prHref = (pr: number) => (repository === null ? null : `https://github.com/${repository}/pull/${pr}`);
  const arbiter = arbiterNoteLine(job);

  if (job.contract) {
    const c = job.contract;
    events.push({
      // The projection serves the frozen commit under frozenAt. No time is served, so the event has none.
      at: null,
      kind: "CONTRACT",
      title: "Acceptance contract frozen",
      detail: `${c.frozenTests} visible and ${c.hiddenTests} hidden tests. Hidden cases sealed.`,
      tone: "open",
      ids: [
        { value: c.frozenAt, label: "Frozen commit" },
        { value: c.hiddenManifest, label: "Hidden cases sealed" },
      ],
      href: null,
    });
  }

  for (const bid of allBids(job)) {
    events.push({
      at: null,
      kind: "BID",
      title: `${bidder(bid)} bid ${usd(bid.price)}`,
      detail: `${eta(bid.eta)}. ${proofLine(bid)}. ${bidStatusWord(bid.status)}.`,
      tone: "open",
      ids: [{ value: bid.id }],
      href: null,
    });
  }

  const held = job.ledger.find((line) => line.kind === "HELD");
  if (held) {
    events.push({
      at: held.at,
      kind: "HELD",
      title: "Payment held in escrow",
      detail: `${usd(held.cents)} held for ${operator}. Only verified proof releases it.`,
      tone: "held",
      ids: [],
      href: null,
    });
  }

  // The arbiter decides on the latest verified attempt, so its note sits right after that attempt. A later
  // attempt is then judged after the note, as it happened.
  const history = job.attempts.history;
  const decided = history.map((a) => a.result).lastIndexOf("VERIFIED");
  const decision = arbiter === null ? null : arbiterEvent(job, arbiter);
  history.forEach((attempt, i) => {
    events.push(attemptEvent(attempt, total, job.status, prHref));
    if (i === decided && decision) events.push(decision);
  });
  if (decision && decided === -1) events.push(decision);

  const verified = [...job.attempts.history].reverse().find((a) => a.result === "VERIFIED");
  if (job.reviewEndsAt !== null) {
    events.push({
      at: verified?.at ?? null,
      kind: "REVIEW",
      title: "Waiting for client review",
      detail: `Approve or dispute by ${utc(job.reviewEndsAt)}. If the client does nothing, Acquit releases the payment then.`,
      tone: "held",
      ids: [],
      href: null,
    });
  }

  if (job.dispute) {
    events.push({
      at: job.dispute.openedAt,
      kind: "DISPUTE",
      title: "Disputed by the client",
      detail: `${job.dispute.reason} The arbiter decides by ${utc(job.dispute.resolveBy)}. The review clock is paused.`,
      tone: "alert",
      ids: [],
      href: null,
    });
  }

  if (job.release) {
    const release = job.release;
    events.push({
      at: release.at,
      kind: "PAYOUT",
      title: "Paid out",
      detail: sentences([
        `${usd(release.paid)} released to ${operator}.`,
        job.releaseAuthority && `${authorityNote(job.releaseAuthority)}.`,
        job.merge && `${mergeNote(job.merge, job.pullRequest, job.mergeCommit)}.`,
      ]),
      tone: "ok",
      ids: [{ value: release.payoutItemId }, { value: release.captureId }],
      href: null,
    });
  }

  const refund = job.ledger.find((line) => line.kind === "REFUND");
  if (refund) {
    events.push({
      at: refund.at,
      kind: "REFUND",
      title: "Refunded to the client",
      detail: sentences([
        `${usd(refund.cents)} refunded.`,
        refundNote(job.refundReason, job.status === "REFUNDED", total),
      ]),
      tone: "new",
      ids: [],
      href: null,
    });
  }

  if (job.receipt) {
    const r = job.receipt;
    const seeded = seededLabel(r.source);
    events.push({
      at: r.releasedAt,
      kind: "RECEIPT",
      title: seeded ? `Receipt (${seeded})` : "Receipt",
      detail: `${usd(r.paid)} paid. Frozen tests ${r.frozen.passed} of ${r.frozen.expected}, hidden tests ${r.hidden.passed} of ${r.hidden.expected}, attempts ${r.attemptsUsed} of ${total}.`,
      tone: "ok",
      ids: [{ value: r.id }, { value: r.mergeCommit }],
      href: prHref(r.pullRequest),
    });
  }

  return events;
}

function attemptEvent(attempt: Attempt, total: number, status: JobView["status"], prHref: (pr: number) => string | null): TimelineEvent {
  const title = `Attempt ${attempt.ordinal} of ${total}`;
  if (attempt.result === "VERIFIED") {
    return {
      at: attempt.at,
      kind: "ATTEMPT",
      title: `${title} verified`,
      detail: `${attempt.frozen.passed} of ${attempt.frozen.expected} visible and ${attempt.hidden.passed} of ${attempt.hidden.expected} hidden tests passed. Pull request #${attempt.pullRequest}.`,
      tone: "ok",
      ids: [{ value: attempt.sourceCommit }],
      href: prHref(attempt.pullRequest),
    };
  }
  const reasons = attempt.reasons.length > 0 ? attempt.reasons.map(sentence) : ["The verifier rejected the work."];
  const unlisted = attempt.reasonsTruncated;
  return {
    at: attempt.at,
    kind: "ATTEMPT",
    title: `${title} rejected`,
    detail: sentences([
      tallyWords(attempt.frozen, attempt.hidden),
      ...reasons,
      unlisted > 0 && `${unlisted} more ${unlisted === 1 ? "reason" : "reasons"} not listed.`,
      status === "IN_PROGRESS" && "Escrow still held.",
    ]),
    tone: "alert",
    ids: [{ value: attempt.sourceCommit }],
    href: null,
  };
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function sentences(parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

/** The arbiter's decision. Its title says which way it went, and the note is the arbiter's own words. */
function arbiterEvent(job: TimelineJob, note: string): TimelineEvent {
  if (job.releaseAuthority === "ARBITER_UPHELD") {
    return { at: null, kind: "ARBITER", title: "Arbiter upheld the work", detail: note, tone: "ok", ids: [], href: null };
  }
  if (job.refundReason === "ARBITER_REFUND") {
    return { at: null, kind: "ARBITER", title: "Arbiter refunded the client", detail: note, tone: "new", ids: [], href: null };
  }
  return { at: null, kind: "ARBITER", title: "Arbiter sent the work back", detail: note, tone: "alert", ids: [], href: null };
}

/**
 * The verifier block sits before the first event that comes after the money is held: the attempts, or the
 * review and settlement when no attempt was judged. With no such event it sits last.
 */
export function verifierIndex(events: readonly TimelineEvent[]): number {
  const index = events.findIndex((e) => e.kind !== "CONTRACT" && e.kind !== "BID" && e.kind !== "HELD");
  return index === -1 ? events.length : index;
}

/** The money card's rows, one per ledger kind. A fee row names its PayPal and Acquit split. */
export function moneyRows(job: Pick<JobView, "ledger">, operator: string): MoneyRow[] {
  const find = <K extends "HELD" | "RELEASED" | "REFUND" | "FEE">(kind: K) =>
    job.ledger.find((line): line is Extract<JobView["ledger"][number], { kind: K }> => line.kind === kind) ?? null;
  const held = find("HELD");
  const released = find("RELEASED");
  const refund = find("REFUND");
  const fee = find("FEE");
  return [
    { key: "HELD", label: "Held", cents: held?.cents ?? null, note: held ? "The client's payment, escrow fee included." : null },
    { key: "RELEASED", label: "Released", cents: released?.cents ?? null, note: released ? `To ${operator}.` : null },
    { key: "REFUND", label: "Refunded", cents: refund?.cents ?? null, note: refund ? "To the client." : null },
    {
      key: "FEE",
      label: "Fee",
      cents: fee?.cents ?? null,
      note: fee ? `PayPal ${usd(fee.processor)}, Acquit ${usd(fee.acquit)}.` : null,
    },
  ];
}

/**
 * The verifier block's first line. The escrow sentence is a warning only while the money is held; a refunded
 * job says where the money went.
 */
export function verifierLine(job: Pick<JobView, "attempts" | "escrow">): string {
  const count = `${job.attempts.used} of ${job.attempts.used + job.attempts.left} attempts used.`;
  if (job.escrow === "HELD") return `${count} A rejection keeps escrow held.`;
  if (job.escrow === "REFUNDED") return `${count} Escrow was refunded to the client.`;
  return count;
}

/** Only the locked operator delivers, and only while the escrow holds work that is ready to submit. */
export function canDeliver(job: TimelineJob, viewer: Viewer): boolean {
  return job.status === "IN_PROGRESS" && job.phase === "READY" && seatOf(job, viewer) === "LOCKED";
}

type StepContext = {
  readonly job: TimelineJob;
  readonly seat: Seat;
  readonly viewer: Viewer;
  readonly operator: string;
  readonly left: number;
  readonly total: number;
};

const FUNDING_WAIT = "PayPal is confirming the payment. Escrow holds the money once it does.";

const NEXT: Record<StateKey, (c: StepContext) => string> = {
  "OPEN/BIDDING": ({ job, seat, viewer }) => {
    if (seat === "CLIENT") {
      return allBids(job).length > 0
        ? "Accept one bid to pay it into escrow."
        : "Waiting for the first bid. Accept one to pay it into escrow.";
    }
    if (seat === "BIDDER") return "Your bid is in. The client accepts one bid to fund escrow.";
    if (viewer.role === "OPERATOR") return "Place a bid. The client accepts one bid to fund escrow.";
    return "The client accepts one bid to fund escrow.";
  },
  "OPEN/FUNDING/CREATING_ORDER": () => FUNDING_WAIT,
  "OPEN/FUNDING/AWAITING_APPROVAL": ({ seat }) =>
    seat === "CLIENT"
      ? "Approve the payment on PayPal to hold it in escrow."
      : "The client is approving the payment on PayPal. Escrow holds the money once it does.",
  "OPEN/FUNDING/CAPTURING": () => FUNDING_WAIT,
  "OPEN/FUNDING/REFUND_PENDING": () => "The payment did not match its order, so PayPal is refunding it.",
  "IN_PROGRESS/READY": ({ job, seat, operator }) => {
    if (seat !== "LOCKED") return `Waiting for ${operator} to deliver. Escrow holds the payment.`;
    const c = job.contract;
    return c
      ? `Deliver the commit with the steps below. Every attempt runs ${c.frozenTests} visible and ${c.hiddenTests} hidden tests.`
      : "Deliver the commit with the steps below.";
  },
  "IN_PROGRESS/READY/REJECTED": ({ seat, operator, left, total }) =>
    seat === "LOCKED"
      ? `The last attempt was rejected and escrow is still held. Fix the work and deliver again. ${left} of ${total} attempts left.`
      : `The last attempt was rejected. Escrow is still held while ${operator} tries again.`,
  "IN_PROGRESS/VERIFYING": ({ job }) => {
    const pending = job.attempts.pending;
    return pending ? `Verification is running. The verdict lands by ${utc(pending.runEndsAt)}.` : "Verification is running.";
  },
  "IN_PROGRESS/REFUND_PENDING": ({ job, total }) =>
    `${refundNote(job.refundReason, false, total) ?? "A refund is in flight."} Nothing to do.`,
  "IN_PROGRESS/REFUND_PENDING/REJECTED": ({ job, total }) =>
    `${refundNote(job.refundReason, false, total) ?? "A refund is in flight."} Escrow is still held until it settles.`,
  "VERIFIED/AWAITING_CLIENT": ({ job, seat }) => {
    const end = job.reviewEndsAt ? utc(job.reviewEndsAt) : "the review deadline";
    return seat === "CLIENT" && job.viewerCanApprove
      ? `Approve to release the payment, or dispute by ${end}. If you do nothing, Acquit releases it then.`
      : `The client reviews until ${end}. If the client does nothing, Acquit releases the payment then.`;
  },
  "VERIFIED/DISPUTED": ({ job }) =>
    job.dispute ? `The payment is paused. An arbiter decides by ${utc(job.dispute.resolveBy)}.` : "The payment is paused for an arbiter.",
  "VERIFIED/RELEASE_PENDING": ({ operator }) => `The payment is being released to ${operator}.`,
  "VERIFIED/REFUND_PENDING": () => "The arbiter's refund is in flight. Nothing to do.",
  "PAID/PAID": ({ operator }) => `Paid to ${operator}. The receipt below is the proof.`,
  "REFUNDED/REFUNDED": () => "Refunded to the client. No money is held.",
  "CLOSED/CLOSED": () => "Closed. Nothing else happens on this job.",
};

/** One line for the viewer: the next thing that happens on this job, and who does it. */
export function nextStep(job: TimelineJob, viewer: Viewer): string {
  return NEXT[stateKey(job)]({
    job,
    seat: seatOf(job, viewer),
    viewer,
    operator: lockedBid(job)?.handle ?? "the operator",
    left: job.attempts.left,
    total: job.attempts.used + job.attempts.left,
  });
}
