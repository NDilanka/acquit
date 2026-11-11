import type { Attempt, JobView, PhysicalContract } from "./api-types";
import { allBids, bidder, lockedBid } from "./bids.ts";
import { arbiterNoteLine, authorityNote, eta, refundNote, usd, utc } from "./format.ts";
import { bidStatusWord, stateKey } from "./job-status.ts";
import { arbiterEvent, type TimelineEvent, type TimelineJob } from "./job-timeline.ts";
import { LASER_WORDS, LASER_WORKFLOW_NAME, reasonWords, tallyWords } from "./receipt-view.ts";
import { seededLabel } from "./scoping-review.ts";

/*
 * A laser-cut job has no tests and no pull request: its judge checks a delivered file against a public spec and
 * sealed checks. These helpers give that job its own words. The code job's timeline stays as it is.
 */

/** The vertical a laser-cut job names. Mirrors core's LASER_VERTICAL, which the browser cannot import. */
export const LASER_VERTICAL = "laser-cut";

export function isLaserJob(job: { readonly vertical?: string }): boolean {
  return job.vertical === LASER_VERTICAL;
}

export type SpecRow = { readonly label: string; readonly value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPair(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** The spec as rows a person reads. A field the spec does not shape as expected is left out, never guessed. */
export function specRows(publicSpec: unknown): readonly SpecRow[] {
  if (!isRecord(publicSpec)) return [];
  const { material, thicknessMm, bedMm, partMm, kerfMm, toleranceMm, minWebMm, holes, slots } = publicSpec;
  const rows: SpecRow[] = [];
  if (typeof material === "string") rows.push({ label: "Material", value: material });
  if (typeof thicknessMm === "number") rows.push({ label: "Thickness", value: `${thicknessMm} mm` });
  if (isPair(bedMm)) rows.push({ label: "Bed", value: `${bedMm[0]} × ${bedMm[1]} mm` });
  if (isPair(partMm)) rows.push({ label: "Part", value: `${partMm[0]} × ${partMm[1]} mm` });
  if (typeof kerfMm === "number") rows.push({ label: "Kerf", value: `${kerfMm} mm` });
  if (typeof toleranceMm === "number") rows.push({ label: "Tolerance", value: `${toleranceMm} mm` });
  if (typeof minWebMm === "number") rows.push({ label: "Minimum web", value: `${minWebMm} mm` });
  if (Array.isArray(holes)) rows.push({ label: "Holes", value: count(holes.length, "hole") });
  if (Array.isArray(slots)) rows.push({ label: "Slots", value: count(slots.length, "slot") });
  return rows;
}

/** What a laser-cut job's page shows of its delivery: the workflow's name, the file it delivers and its spec. */
export type LaserDelivery = { readonly workflow: string; readonly path: string; readonly specDigest: string; readonly rows: readonly SpecRow[] };

export function laserDelivery(physical: PhysicalContract | undefined): LaserDelivery | null {
  if (!physical) return null;
  return {
    workflow: physical.workflow === LASER_VERTICAL ? LASER_WORKFLOW_NAME : physical.workflow,
    path: physical.deliveryPath,
    specDigest: physical.specDigest,
    rows: specRows(physical.publicSpec),
  };
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function sentences(parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

function attemptEvent(attempt: Attempt, total: number, status: JobView["status"]): TimelineEvent {
  const title = `Attempt ${attempt.ordinal} of ${total}`;
  const ids = [{ value: attempt.sourceCommit, label: "Judged commit" }];
  if (attempt.result === "VERIFIED") {
    return {
      at: attempt.at,
      kind: "ATTEMPT",
      title: `${title} verified`,
      detail: tallyWords(attempt.frozen, attempt.hidden, LASER_WORDS) ?? "The delivery passed the checker.",
      tone: "ok",
      ids,
      href: null,
      reasons: [],
    };
  }
  // The reasons arrive as plain sentences from the verdict, so they pass through reasonWords unchanged.
  const reasons = attempt.reasons.length > 0 ? attempt.reasons.map(reasonWords).map(sentence) : ["The checker rejected the delivery."];
  const unlisted = attempt.reasonsTruncated;
  const unlistedLine = unlisted > 0 ? `${unlisted} more ${unlisted === 1 ? "reason" : "reasons"} not listed.` : null;
  const reasonLines = unlistedLine === null ? reasons : [...reasons, unlistedLine];
  const counts = tallyWords(attempt.frozen, attempt.hidden, LASER_WORDS);
  const escrow = status === "IN_PROGRESS" ? "Escrow still held." : null;
  // With counts, the summary is the counts and escrow. The reasons go in their own block beneath it.
  return {
    at: attempt.at,
    kind: "ATTEMPT",
    title: `${title} rejected`,
    detail: counts === null ? sentences([...reasonLines, escrow]) : sentences([counts, escrow]),
    tone: "alert",
    ids,
    href: null,
    reasons: counts === null ? [] : reasonLines,
  };
}

/** The laser-cut job's events in lifecycle order. No copy here names a test suite, a pull request or an approval control. */
export function laserTimelineEvents(job: TimelineJob): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const total = job.attempts.used + job.attempts.left;
  const operator = lockedBid(job)?.handle ?? "the operator";
  const houseClient = job.starter ? { house: "client" as const } : {};
  const physical = job.contract?.physical;

  if (job.contract) {
    const c = job.contract;
    events.push({
      // The projection serves the frozen commit under frozenAt. No time is served, so the event has none.
      at: null,
      kind: "CONTRACT",
      title: "Spec frozen",
      detail: "The public spec is fixed. Its sealed checks stay hidden from the agent.",
      tone: "open",
      ids: [
        { value: c.frozenAt, label: "Frozen commit" },
        ...(physical ? [{ value: physical.specDigest, label: "Spec digest" }] : []),
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
      detail: `The bid offers delivery in ${eta(bid.eta)}. The bid is ${bidStatusWord(bid.status).toLowerCase()}.`,
      tone: "open",
      ids: [{ value: bid.id }],
      href: null,
      reasons: [],
    });
  }

  const held = job.ledger.find((line) => line.kind === "HELD");
  if (held) {
    events.push({
      at: held.at,
      kind: "HELD",
      title: "Payment held in escrow",
      detail: `${usd(held.cents)} held for ${operator}. Only a verified delivery releases it.`,
      tone: "held",
      ids: [],
      href: null,
      reasons: [],
      ...houseClient,
    });
  }

  // The arbiter decides on the latest verified attempt, so its note sits right after that attempt, as in the code timeline.
  const history = job.attempts.history;
  const decided = history.map((a) => a.result).lastIndexOf("VERIFIED");
  const arbiter = arbiterNoteLine(job);
  const decision = arbiter === null ? null : arbiterEvent(job, arbiter);
  history.forEach((attempt, i) => {
    events.push(attemptEvent(attempt, total, job.status));
    if (i === decided && decision) events.push(decision);
  });
  if (decision && decided === -1) events.push(decision);

  if (job.dispute) {
    events.push({
      at: job.dispute.openedAt,
      kind: "DISPUTE",
      title: "Disputed by the client",
      detail: `${job.dispute.reason} The arbiter decides by ${utc(job.dispute.resolveBy)}.`,
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
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
      detail: sentences([`${usd(refund.cents)} refunded.`, refundNote(job.refundReason, job.status === "REFUNDED", total)]),
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
      detail: sentences([
        `${usd(r.paid)} paid.`,
        tallyWords(r.frozen, r.hidden, LASER_WORDS),
        `Attempts used ${r.attemptsUsed} of ${total}.`,
      ]),
      tone: "ok",
      ids: [{ value: r.id }, { value: r.mergeCommit, label: "Delivered commit" }],
      href: null,
      reasons: [],
    });
  }

  return events;
}

/**
 * The one plain line under a laser-cut job's status. It names the next step in the words the API serves: the
 * client's approval goes through the API, and this page holds no control for it. Null when the state needs no line.
 */
export function laserNextLine(job: TimelineJob): string | null {
  const total = job.attempts.used + job.attempts.left;
  const left = `${job.attempts.left} of ${total} attempts left.`;
  switch (stateKey(job)) {
    case "OPEN/BIDDING":
      return "Open for bids. Operators bid through the API.";
    case "IN_PROGRESS/READY":
      return `Waiting for the delivery. ${left}`;
    case "IN_PROGRESS/READY/REJECTED":
      return `The last delivery was rejected. ${left}`;
    case "IN_PROGRESS/VERIFYING":
      return "The delivery is being checked.";
    case "VERIFIED/AWAITING_CLIENT":
      return "Verified. Waiting for the client to approve through the API.";
    case "VERIFIED/DISPUTED":
      return "Disputed by the client. The arbiter decides.";
    case "PAID/PAID":
      return "Paid.";
    default:
      return null;
  }
}
