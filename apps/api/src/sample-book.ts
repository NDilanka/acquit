// The sample book: one frozen, seeded set of escrow jobs for the Studio's sample dashboard. It is literal data,
// built once when the server loads. Nothing here reads the store, no request id reaches it, and no PayPal object
// is read, so every signed-in account gets the same book and no tenant's rows can be reached through it. The figures
// are summed by the same core functions the live dashboard sums, so the two books are read the same way.

import { figureLines, type FigureId } from "../../../packages/core/src/explain.ts";

/** On every PayPal id the sample names and every line's PayPal status: a seeded reference, never a PayPal read. */
export const SAMPLE_PAYPAL_NOTE = "Sample, not checked against PayPal. No PayPal call is made for sample rows.";

/** A label for the sample's jobs, not a real tenant id. */
const TENANT = "sample_book";
const CLIENT = "sample-client";
const AS_OF = "2026-10-20T00:00:00.000Z";

type Tally = { readonly expected: number; readonly passed: number };
type Attempt = {
	readonly ordinal: number;
	readonly result: "VERIFIED" | "REJECTED";
	readonly at: string;
	readonly tamper: boolean;
	readonly reasons: readonly string[];
	readonly frozen: Tally | null;
	readonly hidden: Tally | null;
};
type Line =
	| { readonly kind: "HELD" | "RELEASED" | "REFUND"; readonly cents: number; readonly at: string }
	| { readonly kind: "FEE"; readonly cents: number; readonly processor: number; readonly acquit: number; readonly at: string };
type Bid = { readonly bidId: string; readonly operatorId: string; readonly status: "PENDING" | "ACCEPTED"; readonly priceCents: number;
	readonly etaHours: number; readonly placedAt: string };
/** The PayPal reference a job's money sits on, as the stored book names it. Null on a job that never captured. */
type Settlement = {
	readonly captureId: string;
	readonly orderId: string | null;
	readonly merchant: string;
	readonly state: "CAPTURED" | "RELEASED" | "REFUNDED";
	readonly refundId: string | null;
	readonly refundedCents: number | null;
	readonly payoutItemId: string | null;
	readonly releasedAt: string | null;
};
type SampleJob = {
	readonly jobId: string;
	readonly title: string;
	readonly status: "OPEN" | "IN_PROGRESS" | "VERIFIED" | "PAID" | "REFUNDED";
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	readonly openedAt: string;
	readonly operatorId: string | null;
	readonly lines: readonly Line[];
	readonly receipt: { readonly id: string; readonly releasedAt: string } | null;
	readonly attempts: readonly Attempt[];
	readonly bids: readonly Bid[];
	readonly settlement: Settlement | null;
};

const OPERATORS = [
	{ operatorId: "sample-operator-1", handle: "sample-operator-1", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 1 },
	{ operatorId: "sample-operator-2", handle: "sample-operator-2", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 0 },
	{ operatorId: "sample-operator-3", handle: "sample-operator-3", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 1 },
	{ operatorId: "sample-operator-4", handle: "sample-operator-4", kind: "INDEPENDENT", payoutReadiness: null, paidReceipts: 0 },
] as const;

const JOBS: readonly SampleJob[] = [
	{
		jobId: "job_sample01", title: "Sample: parse the invoice CSV", status: "OPEN", escrow: "NONE", openedAt: "2026-10-01T09:00:00.000Z",
		operatorId: null, lines: [], receipt: null, attempts: [], settlement: null,
		bids: [{ bidId: "bid_sample01a", operatorId: "sample-operator-4", status: "PENDING", priceCents: 4500, etaHours: 48, placedAt: "2026-10-01T10:00:00.000Z" }],
	},
	{
		jobId: "job_sample02", title: "Sample: fix the date parser", status: "IN_PROGRESS", escrow: "HELD", openedAt: "2026-10-02T09:00:00.000Z",
		operatorId: "sample-operator-1", receipt: null,
		lines: [{ kind: "HELD", cents: 12000, at: "2026-10-02T09:30:00.000Z" }],
		attempts: [{ ordinal: 1, result: "REJECTED", at: "2026-10-03T12:00:00.000Z", tamper: false, reasons: ["TESTS_FAILED:frozen"],
			frozen: { expected: 8, passed: 6 }, hidden: { expected: 5, passed: 4 } }],
		bids: [{ bidId: "bid_sample02a", operatorId: "sample-operator-1", status: "ACCEPTED", priceCents: 12000, etaHours: 72, placedAt: "2026-10-02T10:00:00.000Z" }],
		settlement: { captureId: "SAMPLE-CAPTURE-02", orderId: "SAMPLE-ORDER-02", merchant: "SAMPLE-MERCHANT-1", state: "CAPTURED",
			refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null },
	},
	{
		jobId: "job_sample03", title: "Sample: add rate limits to the webhook", status: "VERIFIED", escrow: "HELD", openedAt: "2026-10-03T09:00:00.000Z",
		operatorId: "sample-operator-2", receipt: null,
		lines: [{ kind: "HELD", cents: 20000, at: "2026-10-03T09:30:00.000Z" }],
		attempts: [
			{ ordinal: 1, result: "REJECTED", at: "2026-10-04T12:00:00.000Z", tamper: true, reasons: ["PROTECTED_PATH_MODIFIED"], frozen: null, hidden: null },
			{ ordinal: 2, result: "VERIFIED", at: "2026-10-05T12:00:00.000Z", tamper: false, reasons: [], frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 5 } },
		],
		bids: [{ bidId: "bid_sample03a", operatorId: "sample-operator-2", status: "ACCEPTED", priceCents: 20000, etaHours: 48, placedAt: "2026-10-03T10:00:00.000Z" }],
		settlement: { captureId: "SAMPLE-CAPTURE-03", orderId: "SAMPLE-ORDER-03", merchant: "SAMPLE-MERCHANT-2", state: "CAPTURED",
			refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null },
	},
	{
		jobId: "job_sample04", title: "Sample: cache the price table", status: "PAID", escrow: "RELEASED", openedAt: "2026-10-04T09:00:00.000Z",
		operatorId: "sample-operator-1",
		lines: [
			{ kind: "HELD", cents: 15000, at: "2026-10-05T09:00:00.000Z" },
			{ kind: "RELEASED", cents: 13500, at: "2026-10-06T10:00:00.000Z" },
			{ kind: "FEE", cents: 1500, processor: 900, acquit: 600, at: "2026-10-06T10:00:00.000Z" },
		],
		receipt: { id: "SAMPLE-RECEIPT-04", releasedAt: "2026-10-06T10:00:00.000Z" },
		attempts: [{ ordinal: 1, result: "VERIFIED", at: "2026-10-05T11:00:00.000Z", tamper: false, reasons: [],
			frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 5 } }],
		bids: [{ bidId: "bid_sample04a", operatorId: "sample-operator-1", status: "ACCEPTED", priceCents: 15000, etaHours: 48, placedAt: "2026-10-04T10:00:00.000Z" }],
		settlement: { captureId: "SAMPLE-CAPTURE-04", orderId: null, merchant: "SAMPLE-MERCHANT-1", state: "RELEASED",
			refundId: null, refundedCents: null, payoutItemId: "SAMPLE-PAYOUT-04", releasedAt: "2026-10-06T10:00:00.000Z" },
	},
	{
		jobId: "job_sample05", title: "Sample: export the audit log", status: "REFUNDED", escrow: "REFUNDED", openedAt: "2026-10-04T11:00:00.000Z",
		operatorId: "sample-operator-2", receipt: null,
		lines: [
			{ kind: "HELD", cents: 9000, at: "2026-10-04T12:00:00.000Z" },
			{ kind: "REFUND", cents: 9000, at: "2026-10-08T09:00:00.000Z" },
		],
		attempts: [{ ordinal: 1, result: "REJECTED", at: "2026-10-07T12:00:00.000Z", tamper: false, reasons: ["TESTS_FAILED:hidden"],
			frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 3 } }],
		bids: [{ bidId: "bid_sample05a", operatorId: "sample-operator-2", status: "ACCEPTED", priceCents: 9000, etaHours: 72, placedAt: "2026-10-04T13:00:00.000Z" }],
		settlement: { captureId: "SAMPLE-CAPTURE-05", orderId: null, merchant: "SAMPLE-MERCHANT-2", state: "REFUNDED",
			refundId: "SAMPLE-REFUND-05", refundedCents: 9000, payoutItemId: null, releasedAt: null },
	},
	{
		jobId: "job_sample06", title: "Sample: index the search fixtures", status: "PAID", escrow: "RELEASED", openedAt: "2026-10-03T11:00:00.000Z",
		operatorId: "sample-operator-3",
		lines: [
			{ kind: "HELD", cents: 8000, at: "2026-10-03T12:00:00.000Z" },
			{ kind: "RELEASED", cents: 6800, at: "2026-10-07T09:00:00.000Z" },
			{ kind: "FEE", cents: 1200, processor: 700, acquit: 500, at: "2026-10-07T09:00:00.000Z" },
		],
		receipt: { id: "SAMPLE-RECEIPT-06", releasedAt: "2026-10-07T09:00:00.000Z" },
		attempts: [
			{ ordinal: 1, result: "REJECTED", at: "2026-10-04T12:00:00.000Z", tamper: false, reasons: ["TESTS_FAILED:frozen"],
				frozen: { expected: 8, passed: 7 }, hidden: { expected: 5, passed: 5 } },
			{ ordinal: 2, result: "VERIFIED", at: "2026-10-06T12:00:00.000Z", tamper: false, reasons: [],
				frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 5 } },
		],
		bids: [{ bidId: "bid_sample06a", operatorId: "sample-operator-3", status: "ACCEPTED", priceCents: 8000, etaHours: 48, placedAt: "2026-10-03T13:00:00.000Z" }],
		settlement: { captureId: "SAMPLE-CAPTURE-06", orderId: null, merchant: "SAMPLE-MERCHANT-3", state: "RELEASED",
			refundId: null, refundedCents: null, payoutItemId: "SAMPLE-PAYOUT-06", releasedAt: "2026-10-07T09:00:00.000Z" },
	},
];

const sumOf = (job: SampleJob, kind: Line["kind"]): number =>
	job.lines.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.cents, 0);

function feeOf(job: SampleJob): { cents: number; processor: number; acquit: number } | null {
	for (const line of job.lines) if (line.kind === "FEE") return { cents: line.cents, processor: line.processor, acquit: line.acquit };
	return null;
}

const stageOf = (job: SampleJob): string => {
	switch (job.status) {
		case "PAID": return "5 Paid";
		case "VERIFIED": return "4 Verified";
		case "IN_PROGRESS": return "3 Funded";
		case "REFUNDED": return "6 Refunded";
		case "OPEN": return job.bids.length === 0 ? "1 Posted" : "2 Bid";
	}
};

function ledgerJobOf(job: SampleJob) {
	const held = sumOf(job, "HELD");
	const settlement = job.settlement;
	const holding = job.escrow === "HELD" && settlement !== null;
	const operator = job.operatorId === null ? null : { id: job.operatorId, handle: job.operatorId };
	return {
		jobId: job.jobId, title: job.title, tenant: TENANT, client: CLIENT, status: job.status, escrow: job.escrow, operator,
		lines: job.lines, paidCents: job.lines.some((line) => line.kind === "HELD") ? held : null,
		capture: holding ? { orderId: settlement.orderId, captureId: settlement.captureId, payee: settlement.merchant, gross: held } : null,
		fee: feeOf(job),
		payout: job.receipt !== null && settlement !== null && settlement.payoutItemId !== null
			? { paid: sumOf(job, "RELEASED"), payoutItemId: settlement.payoutItemId, captureId: settlement.captureId,
				releasedAt: settlement.releasedAt, authority: null }
			: null,
		receipt: job.receipt === null ? null : { id: job.receipt.id, paid: sumOf(job, "RELEASED"), releasedAt: job.receipt.releasedAt },
		attempts: job.attempts.map((attempt) => ({ ordinal: attempt.ordinal, result: attempt.result, at: attempt.at, tamper: attempt.tamper,
			reasons: attempt.reasons, frozen: attempt.frozen, hidden: attempt.hidden })),
	};
}

/** The platform's seven tables, projected the way the live book projects them: one row per job, line, bid, attempt, and capture. */
function tablesOf(jobs: readonly SampleJob[]) {
	return {
		jobs: jobs.map((job) => ({
			jobId: job.jobId, title: job.title, tenant: TENANT, clientId: CLIENT, status: job.status, escrow: job.escrow, stage: stageOf(job),
			operatorId: job.operatorId, operatorHandle: job.operatorId, openedAt: job.openedAt, releasedAt: job.receipt?.releasedAt ?? null,
			bidCount: job.bids.length, attemptCount: job.attempts.length,
			grossCents: job.escrow === "NONE" ? 0 : sumOf(job, "HELD"), heldCents: job.escrow === "HELD" ? sumOf(job, "HELD") : 0,
			releasedCents: sumOf(job, "RELEASED"), feeCents: feeOf(job)?.cents ?? 0, refundedCents: sumOf(job, "REFUND"),
		})),
		bids: jobs.flatMap((job) => job.bids.map((bid) => ({ bidId: bid.bidId, jobId: job.jobId, operatorId: bid.operatorId,
			handle: bid.operatorId, kind: "INDEPENDENT", status: bid.status, priceCents: bid.priceCents, etaHours: bid.etaHours, placedAt: bid.placedAt }))),
		verdicts: jobs.flatMap((job) => job.attempts.map((attempt) => ({ verdictId: `${job.jobId}#${attempt.ordinal}`, jobId: job.jobId,
			ordinal: attempt.ordinal, result: attempt.result, verified: attempt.result === "VERIFIED" ? 1 : 0, tamper: attempt.tamper ? 1 : 0,
			reasonCount: attempt.reasons.length, at: attempt.at }))),
		ledger_entries: jobs.flatMap((job) => job.lines.map((line, index) => ({ entryId: `${job.jobId}#${index}`, jobId: job.jobId, kind: line.kind,
			cents: line.cents, at: line.at, captureId: job.settlement?.captureId ?? null, operatorId: job.operatorId,
			processorCents: line.kind === "FEE" ? line.processor : null, acquitCents: line.kind === "FEE" ? line.acquit : null }))),
		paypal_events: jobs.flatMap((job) => job.settlement === null ? [] : [{ captureId: job.settlement.captureId, jobId: job.jobId,
			orderId: job.settlement.orderId, merchant: job.settlement.merchant, state: job.settlement.state, grossCents: sumOf(job, "HELD"),
			refundId: job.settlement.refundId, refundedCents: job.settlement.refundedCents, payoutItemId: job.settlement.payoutItemId,
			releasedAt: job.settlement.releasedAt }]),
		operators: OPERATORS.map((operator) => ({ ...operator })),
		clients: [{ clientId: CLIENT, jobCount: jobs.length }],
	};
}

function buildBook() {
	const jobs = JOBS.map(ledgerJobOf);
	const tables = tablesOf(JOBS);
	const captured = new Set(tables.paypal_events.map((event) => event.captureId));
	const tied = tables.ledger_entries.filter((entry) => entry.captureId !== null && captured.has(entry.captureId)).length;
	return {
		jobs, tables,
		response: { asOf: AS_OF, jobs, tables, reconciliation: { entries: tables.ledger_entries.length, tied, note: SAMPLE_PAYPAL_NOTE } },
	};
}

const BOOK = buildBook();

/** `GET /api/sample/book`: the whole sample book. The same answer for every signed-in account, on every load. */
export function sampleBook() {
	return BOOK.response;
}

/**
 * `GET /api/sample/explain`: one figure traced to the sample lines behind it, through the core figure function the live
 * explain uses. Each line names its sample PayPal reference and says it was not checked against PayPal.
 */
export function sampleExplain(figure: FigureId) {
	const settlements = new Map(JOBS.map((job) => [job.jobId, job.settlement] as const));
	const trace = figureLines(BOOK.jobs, figure);
	return {
		figure: trace.figure,
		label: trace.label,
		totalCents: trace.totalCents,
		lines: trace.lines.map((line) => {
			const settlement = settlements.get(line.jobId) ?? null;
			const id = line.kind === "REFUND" ? settlement?.refundId ?? null
				: line.kind === "RELEASED" ? settlement?.payoutItemId ?? null
				: settlement?.captureId ?? null;
			return { ...line, paypal: { id, status: "NOT_CHECKED" as const, checkedCents: null, observedCents: null, note: SAMPLE_PAYPAL_NOTE } };
		}),
	};
}
