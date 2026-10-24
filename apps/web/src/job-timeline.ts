import type { Attempt, FiledAnswer, JobView, ProviderDisputeView, VerifierFields } from "./api-types";
import { allBids, bidder, lockedBid, proofLine } from "./bids.ts";
import { arbiterNoteLine, authorityNote, deadlineOutcome, eta, mergeNote, refundNote, usd, utc } from "./format.ts";
import { bidStatusWord, payoutHeldBy, stateKey, type StateKey, type StatusTone } from "./job-status.ts";
import { STARTER_COPY } from "./operator-views.ts";
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
  /** The reason lines of a counted rejection, shown beneath its detail. Empty for every other event. */
  readonly reasons: readonly string[];
  /** Set only when the event names a party Acquit runs: a House agent's bid, or the House client of a starter job. */
  readonly house?: "agent" | "client";
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
  const houseClient = job.starter ? { house: "client" as const } : {};

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
      reasons: [],
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
      reasons: [],
      ...(bid.label === "HOUSE" ? { house: "agent" as const } : {}),
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
      reasons: [],
      ...houseClient,
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
    // While PayPal holds the payout, the review timeout only records the release, so the row never promises a payout.
    const silence = payoutHeldBy(job.providerDispute)
      ? "If the client does nothing, Acquit records the release then, and the payout waits until PayPal decides the dispute."
      : "If the client does nothing, Acquit releases the payment then.";
    events.push({
      at: verified?.at ?? null,
      kind: "REVIEW",
      title: "Waiting for client review",
      detail: `Approve or dispute by ${utc(job.reviewEndsAt)}. ${silence}`,
      tone: "held",
      ids: [],
      href: null,
      reasons: [],
      ...houseClient,
    });
  }

  if (job.dispute) {
    events.push({
      at: job.dispute.openedAt,
      kind: "DISPUTE",
      title: "Disputed by the client",
      detail: `${job.dispute.reason} The arbiter decides by ${utc(job.dispute.resolveBy)}, or ${deadlineOutcome(payoutHeldBy(job.providerDispute))} The review clock is paused.`,
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
    });
  }

  events.push(...providerDisputeEvents(job));

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
      reasons: [],
      ...houseClient,
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
      reasons: [],
      ...houseClient,
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
      reasons: [],
    });
  }

  return events;
}

/**
 * The plain words for a refused answer's reason. Mirrors core's refusalWording: the record keeps PayPal's code, and no code reaches a person.
 * The access refusal and any other plain reason pass through unchanged.
 */
function refusalWords(reason: string): string {
  if (reason === "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED") return "PayPal refused the evidence type";
  if (reason === "PAYPAL_HTTP_400" || reason.startsWith("PAYPAL_400_")) return "PayPal refused the answer as invalid";
  if (reason.startsWith("PAYPAL_")) return "PayPal refused the answer";
  return reason;
}

/**
 * The plain words for an answer PayPal did not take, from the note the record keeps. An ALREADY note says PayPal held an answer
 * already; any other settled note says the dispute had left the state that takes one.
 */
function notTakenWords(note: string): string {
  return note.includes("ALREADY") ? "PayPal already held an answer to the dispute" : "the dispute was no longer open to it";
}

/** PayPal's dispute stages in plain words. A stage the table does not name reads as "dispute". */
const STAGE_WORDS = new Map([["INQUIRY", "inquiry"], ["CHARGEBACK", "chargeback"], ["PRE_ARBITRATION", "pre-arbitration"], ["ARBITRATION", "arbitration"]]);

/** The stage in brackets after an answer's title, such as " (chargeback)". Nothing where the record names no stage the table knows. */
function stageSuffix(stage: string | null | undefined): string {
  const words = stage === null || stage === undefined ? undefined : STAGE_WORDS.get(stage);
  return words === undefined ? "" : ` (${words})`;
}

/** The evidence types PayPal can ask for, in plain words. A type the table does not name reads as "more evidence". */
const EVIDENCE_ASKED = new Map([["PROOF_OF_FULFILLMENT", "proof of fulfilment"], ["PROOF_OF_REFUND", "refund proof"], ["OTHER", "other evidence"]]);

/** The evidence type Acquit filed, in plain words. */
const EVIDENCE_FILED: Record<"PROOF_OF_FULFILLMENT" | "OTHER", string> = { PROOF_OF_FULFILLMENT: "Proof of fulfilment", OTHER: "Other evidence" };

/** PayPal's state of the buyer's dispute, from its status and stage. Only an unresolved dispute reaches it, so no decided state is named. */
function payPalStateWords(dispute: Pick<ProviderDisputeView, "status" | "stage">): string {
  const stage = (dispute.stage === null ? undefined : STAGE_WORDS.get(dispute.stage)) ?? "dispute";
  switch (dispute.status) {
    case "WAITING_FOR_SELLER_RESPONSE": return "PayPal is waiting for the seller's answer.";
    case "WAITING_FOR_BUYER_RESPONSE": return "PayPal is waiting for the buyer.";
    case "UNDER_REVIEW": return `PayPal is reviewing the ${stage}.`;
    default: return `PayPal has the ${stage} open.`;
  }
}

/**
 * What PayPal asked the seller for, and the refund proof it could not get: Acquit made no refund, so it sent none.
 * Null when the record names no request.
 */
function evidenceAskedLine(requested: ProviderDisputeView["requestedEvidence"], madeRefund: boolean): string | null {
  if (requested === null || requested.length === 0) return null;
  const words = [...new Set(requested.map((code) => EVIDENCE_ASKED.get(code) ?? "more evidence"))];
  const noRefund = requested.includes("PROOF_OF_REFUND") && !madeRefund ? "Acquit made no refund, so it cannot send refund proof." : null;
  return sentences([`PayPal asked for ${words.join(" or ")}.`, noRefund]);
}

/** What a PayPal hold means for the job's next step. The payout waits on PayPal in every phase, and an approval only records the release. */
function holdWords(job: TimelineJob): string {
  if (job.status === "VERIFIED" && job.phase === "RELEASE_PENDING") {
    return "The approval is recorded. The payout waits until PayPal decides the dispute for the seller.";
  }
  if (job.status === "VERIFIED" && job.phase === "AWAITING_CLIENT") {
    return "Approving records the release, but the payout waits until PayPal decides the dispute for the seller.";
  }
  return "The payout waits until PayPal decides the dispute for the seller.";
}

/**
 * The PayPal buyer dispute, in the order it happens: opened, then the payment held while PayPal reviews it, then
 * decided for the seller or the buyer. PayPal serves no time for the hold or the decision, so those have none.
 */
function providerDisputeEvents(job: TimelineJob): TimelineEvent[] {
  const dispute = job.providerDispute;
  if (!dispute) return [];
  const reason = dispute.reason.replace(/_/g, " ").toLowerCase();
  const events: TimelineEvent[] = [{
    at: dispute.openedAt,
    kind: "DISPUTE",
    title: `Buyer opened a PayPal dispute (${reason})`,
    detail: dispute.amount === null ? "Disputed with PayPal. The amount could not be read." : `${usd(dispute.amount)} disputed with PayPal.`,
    tone: "alert",
    ids: [{ value: dispute.id, label: "PayPal dispute" }],
    href: null,
    reasons: [],
  }];
  const simulated = dispute.simulated ? " (Simulated)" : "";
  // The stage the answer on the record files under, so a queued, refused, or filed answer names the stage it is for.
  const stage = stageSuffix(dispute.answerStage);
  const answer = dispute.answerState;
  // Every answer PayPal took is an event of its own, oldest first. The answer on the record is shown below only when its round is not one of them.
  for (const entry of dispute.answerHistory) {
    const event = filedAnswerEvent(job, dispute, entry, simulated);
    if (event) events.push(event);
  }
  const current = dispute.answerHistory.some(entry => entry.round === dispute.answerRound) ? null : dispute.answer;
  if (answer?.state === "REFUSED") {
    // PayPal refused the answer for good. The payment stays held, and a person has an alert with the same reason.
    events.push({
      at: null,
      kind: "DISPUTE",
      title: `PayPal refused Acquit's answer${stage}: ${refusalWords(answer.reason)}. The payment stays held.`,
      detail: "Acquit's answer did not reach PayPal. An alert went to a person.",
      tone: "alert",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  } else if (answer?.state === "FILED" && dispute.answerNote !== null && current !== null && current !== "NOT_ANSWERABLE") {
    // PayPal did not take the answer, so it is never called filed or sent. Nothing reached the history, and no alert went to a person.
    events.push({
      at: null,
      kind: "DISPUTE",
      title: `PayPal did not take Acquit's answer${stage}: ${notTakenWords(dispute.answerNote)}.`,
      detail: "PayPal took nothing from the answer, so the answer history keeps no entry for it. No alert went to a person.",
      tone: "alert",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  } else if (current === "EVIDENCE") {
    // A paid job's answer is its receipt. A held job has no receipt yet, so it names the verified attempt it filed instead.
    const what = job.status === "PAID" ? "the receipt" : "its verified attempt";
    const queued = answer?.state === "QUEUED";
    // The type is the one Acquit filed for this round, not one a later delivery asks for. With no type on the record, the answer reads as plain evidence.
    const label = dispute.evidenceType === null ? "evidence" : EVIDENCE_FILED[dispute.evidenceType];
    const asked = evidenceAskedLine(dispute.requestedEvidence, job.ledger.some((line) => line.kind === "REFUND"));
    events.push({
      at: null,
      kind: "DISPUTE",
      title: queued ? `Acquit is sending ${what} as ${label} to PayPal${stage}` : `Acquit filed ${what} as ${label} with PayPal${stage}${simulated}`,
      detail: sentences([asked, queued ? "PayPal has not confirmed the evidence yet." : "The evidence names the frozen and hidden test counts, the pull request, and the judged commit."]),
      tone: "held",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  } else if (current === "MESSAGE") {
    // The same receipt-cited notes as the evidence, sent as a message while PayPal's dispute is at its inquiry stage.
    const what = job.status === "PAID" ? "the receipt" : "its verified attempt";
    const queued = answer?.state === "QUEUED";
    events.push({
      at: null,
      kind: "DISPUTE",
      title: queued ? `Acquit is sending ${what} as a message to PayPal on dispute ${dispute.id}${stage}`
        : `Acquit sent PayPal ${what} as a message on dispute ${dispute.id}${stage}${simulated}`,
      detail: queued ? "PayPal has not confirmed the message yet." : "The message names the frozen and hidden test counts, the pull request, and the judged commit.",
      tone: "held",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  } else if (current === "ACCEPT") {
    const queued = answer?.state === "QUEUED";
    events.push({
      at: null,
      kind: "DISPUTE",
      title: queued ? `Acquit is sending its acceptance of the buyer's claim to PayPal${stage}` : `Acquit accepted the buyer's claim${stage}${simulated}`,
      detail: queued ? "PayPal has not confirmed the acceptance yet." : "PayPal returns the held funds to the buyer when it decides the dispute.",
      tone: "alert",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  } else if (current === "NOT_ANSWERABLE") {
    events.push({
      at: null,
      kind: "DISPUTE",
      title: "Acquit could not answer this dispute on its own",
      detail: "No held escrow was left to defend. A person has to decide it.",
      tone: "alert",
      ids: [{ value: dispute.id, label: "PayPal dispute" }],
      href: null,
      reasons: [],
    });
  }
  if (dispute.unconfirmed) {
    // PayPal refused the read, so Acquit holds only a signed notice. The notice holds the payout and settles nothing.
    // An open dispute is held and not yet decided, so only a resolved one says its release or refund is not confirmed.
    const title = dispute.status === "RESOLVED" ? "PayPal refused the dispute read; release or refund not confirmed"
      : "PayPal refused the dispute read; the dispute is open and the payment stays held";
    events.push({
      at: null,
      kind: "DISPUTE",
      title,
      detail: "The payment stays held. Acquit has only PayPal's signed notice for this dispute. A person has to check it with PayPal.",
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
    });
    return events;
  }
  if (dispute.status !== "RESOLVED") {
    // The payment is held while PayPal decides the buyer's dispute, in any phase. Once it has paid out, nothing is held.
    if (job.escrow === "HELD") {
      events.push({
        at: null,
        kind: "DISPUTE",
        title: "Payment held while PayPal reviews the buyer's dispute",
        detail: sentences([payPalStateWords(dispute), holdWords(job)]),
        tone: "held",
        ids: [],
        href: null,
        reasons: [],
      });
    }
    return events;
  }
  if (!payoutHeldBy(dispute)) {
    events.push({
      at: null,
      kind: "DISPUTE",
      title: "PayPal resolved the dispute for the seller",
      detail: "Nothing holds the payout for this dispute now.",
      tone: "ok",
      ids: [],
      href: null,
      reasons: [],
    });
    return events;
  }
  const forBuyer = dispute.outcome === "RESOLVED_BUYER_FAVOUR";
  if (forBuyer && job.status === "REFUNDED") {
    // Acquit settled the held escrow as refunded. PayPal had already reversed the funds, so no refund call went out.
    events.push({
      at: null,
      kind: "DISPUTE",
      title: "PayPal resolved the dispute for the buyer. The escrow was returned to the buyer.",
      detail: "Acquit settled the job as refunded. No refund call went to PayPal, because PayPal had already reversed the funds.",
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
    });
    return events;
  }
  if (forBuyer && job.status === "PAID") {
    // The payout left before PayPal decided, so nothing is held. Acquit raised an alert for a person.
    events.push({
      at: null,
      kind: "DISPUTE",
      title: "PayPal resolved the dispute for the buyer after the payout left",
      detail: "The payout had already left. Acquit has not decided what becomes of the money.",
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
    });
    return events;
  }
  events.push({
    at: null,
    kind: "DISPUTE",
    title: forBuyer ? "PayPal resolved the dispute for the buyer" : "PayPal resolved the dispute",
    detail: "The payout stays held. Acquit has not decided what becomes of the money.",
    tone: "alert",
    ids: [],
    href: null,
    reasons: [],
  });
  return events;
}

/**
 * One answer PayPal took, in the words the current answer uses, with the stage it was filed under when the record kept one. The time
 * is when Acquit queued it, the same for every dispatch of it. Null for an answer that is never filed (not answerable), which the
 * history never holds.
 */
function filedAnswerEvent(job: TimelineJob, dispute: ProviderDisputeView, entry: FiledAnswer, simulated: string): TimelineEvent | null {
  const what = job.status === "PAID" ? "the receipt" : "its verified attempt";
  const stage = stageSuffix(entry.stage);
  const ids = [{ value: dispute.id, label: "PayPal dispute" }];
  if (entry.answer === "EVIDENCE") {
    const label = entry.evidenceType === undefined ? "evidence" : EVIDENCE_FILED[entry.evidenceType];
    return {
      at: entry.filedAt,
      kind: "DISPUTE",
      title: `Acquit filed ${what} as ${label} with PayPal${stage}${simulated}`,
      detail: "The evidence names the frozen and hidden test counts, the pull request, and the judged commit.",
      tone: "held",
      ids,
      href: null,
      reasons: [],
    };
  }
  if (entry.answer === "MESSAGE") {
    return {
      at: entry.filedAt,
      kind: "DISPUTE",
      title: `Acquit sent PayPal ${what} as a message on dispute ${dispute.id}${stage}${simulated}`,
      detail: "The message names the frozen and hidden test counts, the pull request, and the judged commit.",
      tone: "held",
      ids,
      href: null,
      reasons: [],
    };
  }
  if (entry.answer === "ACCEPT") {
    return {
      at: entry.filedAt,
      kind: "DISPUTE",
      title: `Acquit accepted the buyer's claim${stage}${simulated}`,
      detail: "PayPal returns the held funds to the buyer when it decides the dispute.",
      tone: "alert",
      ids,
      href: null,
      reasons: [],
    };
  }
  return null;
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
      reasons: [],
    };
  }
  const reasons = attempt.reasons.length > 0 ? attempt.reasons.map(sentence) : ["The verifier rejected the work."];
  const unlisted = attempt.reasonsTruncated;
  const unlistedLine = unlisted > 0 ? `${unlisted} more ${unlisted === 1 ? "reason" : "reasons"} not listed.` : null;
  const reasonLines = unlistedLine === null ? reasons : [...reasons, unlistedLine];
  const counts = tallyWords(attempt.frozen, attempt.hidden);
  const escrow = status === "IN_PROGRESS" ? "Escrow still held." : null;
  // With counts, the summary is the counts and escrow. The reasons go in their own block beneath it.
  return {
    at: attempt.at,
    kind: "ATTEMPT",
    title: `${title} rejected`,
    detail: counts === null ? sentences([...reasonLines, escrow]) : sentences([counts, escrow]),
    tone: "alert",
    ids: [{ value: attempt.sourceCommit }],
    href: null,
    reasons: counts === null ? [] : reasonLines,
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
    return { at: null, kind: "ARBITER", title: "Arbiter upheld the work", detail: note, tone: "ok", ids: [], href: null, reasons: [] };
  }
  if (job.refundReason === "ARBITER_REFUND") {
    return { at: null, kind: "ARBITER", title: "Arbiter refunded the client", detail: note, tone: "new", ids: [], href: null, reasons: [] };
  }
  return { at: null, kind: "ARBITER", title: "Arbiter sent the work back", detail: note, tone: "alert", ids: [], href: null, reasons: [] };
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
    if (job.starter) {
      if (job.fundingReturned) return STARTER_COPY.returned;
      if (seat === "BIDDER") return `Your bid is in. ${STARTER_COPY.accepts}`;
      return viewer.role === "OPERATOR" ? `Place a bid. ${STARTER_COPY.accepts}` : STARTER_COPY.accepts;
    }
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
    // While PayPal holds the payout, an approval only records the release, so the line never promises one.
    if (payoutHeldBy(job.providerDispute)) {
      return seat === "CLIENT" && job.viewerCanApprove
        ? `Approve to record the release, or dispute by ${end}. PayPal holds the payout while it reviews the buyer's dispute, so nothing pays out yet.`
        : `The client reviews until ${end}. PayPal holds the payout while it reviews the buyer's dispute, so nothing pays out yet.`;
    }
    // The House approval can fail to arrive; the review-silence release still applies, so the line names its deadline.
    if (job.starter) return `Verified. The House client approves in about a minute. If approval has not arrived, Acquit releases the payment when the review window closes at ${end}.`;
    return seat === "CLIENT" && job.viewerCanApprove
      ? `Approve to release the payment, or dispute by ${end}. If you do nothing, Acquit releases it then.`
      : `The client reviews until ${end}. If the client does nothing, Acquit releases the payment then.`;
  },
  "VERIFIED/DISPUTED": ({ job }) =>
    job.dispute ? `The payment is paused. An arbiter decides by ${utc(job.dispute.resolveBy)}, or ${deadlineOutcome(payoutHeldBy(job.providerDispute))}` : "The payment is paused for an arbiter.",
  "VERIFIED/RELEASE_PENDING": ({ operator }) => `The payment is being released to ${operator}.`,
  "VERIFIED/RELEASE_PENDING/DISPUTE_HELD": () => "The payout is held because of a buyer's PayPal dispute. Nothing to do.",
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
