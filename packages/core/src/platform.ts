// The platform ledger's read: every job's money lines across all tenants, for the platform role's
// dashboards alone. A projection, not a command path: it reads the stored books and serves the same
// facts the job view serves, with the one-tenant rule lifted for this one query and role.

import type { ClientId, Instant, JobId, JobStatus, OperatorId, UsdCents, VisitorId } from "./acquit.ts";
import type { CaptureId, MerchantId, OrderId } from "./ids.ts";
import { attemptView, storedBook } from "./job.ts";
import type { JobRow } from "./job.ts";
import type { LedgerLine } from "./ledger.ts";
import type { OperatorRow } from "./operator.ts";
import { isTestTamper } from "./verifier.ts";

export type PlatformAttempt = {
	readonly ordinal: number;
	readonly result: "VERIFIED" | "REJECTED";
	readonly at: Instant;
	/** True when the rejection named the frozen tests: a tamper the verifier caught. */
	readonly tamper: boolean;
	readonly reasons: readonly string[];
};

export type PlatformFee = { readonly cents: UsdCents; readonly processor: UsdCents; readonly acquit: UsdCents };

export type PlatformJobLedger = {
	readonly jobId: JobId;
	readonly title: string;
	/** The visitor that owns the job's world, or null for the deployment's own seeded world. */
	readonly tenant: VisitorId | null;
	readonly client: ClientId;
	readonly status: JobStatus;
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	/** The operator the job is locked to or was paid through. Null before any accept. */
	readonly operator: { readonly id: OperatorId; readonly handle: string } | null;
	/** The stored book, line for line: the route serves the book, never a re-derivation of it. */
	readonly lines: readonly LedgerLine[];
	/** The gross the capture held: the HELD line's cents. Null before any capture. */
	readonly paidCents: UsdCents | null;
	/** The funding capture a held escrow was paid with, so a ledger agent can ask PayPal whether it
	 * agrees. Null before any capture and on a settled job: a release names its payout, a refund its
	 * refund, so the settled book keeps none of the held capture here. */
	readonly capture: { readonly orderId: OrderId; readonly captureId: CaptureId; readonly payee: MerchantId;
		readonly gross: UsdCents } | null;
	readonly fee: PlatformFee | null;
	/** The referenced payout that paid the operator, on a released job alone. */
	readonly payout: { readonly paid: UsdCents; readonly payoutItemId: string; readonly captureId: string | null;
		readonly releasedAt: Instant; readonly authority: string | null } | null;
	readonly receipt: { readonly id: string; readonly paid: UsdCents; readonly releasedAt: Instant } | null;
	/** Every verdict the row holds: the judged attempts, and a legacy paid row's receipt-verified one. */
	readonly attempts: readonly PlatformAttempt[];
};

export type PlatformLedgerView = { readonly jobs: readonly PlatformJobLedger[] };

export function platformJobLedger(row: JobRow): PlatformJobLedger {
	const state = row.state;
	const payeeOperator = state.status === "PAID" || state.status === "REFUNDED" ? state.payee.operator
		: state.status === "IN_PROGRESS" || state.status === "VERIFIED" ? state.escrow.payee.operator : null;
	const accepted = payeeOperator === null ? null
		: row.bids.find(bid => bid.operator === payeeOperator && bid.status === "ACCEPTED") ?? null;
	const lines = storedBook(row);
	const fee = lines.find(line => line.kind === "FEE");
	const held = lines.find(line => line.kind === "HELD");
	const history = state.status === "IN_PROGRESS" ? state.attempts.history
		: state.status === "VERIFIED" || state.status === "REFUNDED" || state.status === "PAID" ? state.history : [];
	const judged = history.map(record => {
		const view = attemptView(record);
		return { ordinal: view.ordinal, result: view.result, at: view.at,
			tamper: record.verdict.result === "REJECTED" && record.verdict.reasons.some(isTestTamper), reasons: view.reasons };
	});
	// A paid row keeps the history it settled with. A row stored before the field reads empty, and its
	// receipt's own verified attempt is the one verdict it can still name.
	const attempts = state.status === "PAID" && judged.length === 0
		? [{ ordinal: state.receipt.attemptsUsed, result: "VERIFIED" as const, at: state.receipt.releasedAt, tamper: false, reasons: [] }]
		: judged;
	return { jobId: row.id, title: row.title, tenant: row.tenant ?? null, client: row.client, status: state.status,
		escrow: state.status === "PAID" ? "RELEASED" : state.status === "REFUNDED" ? "REFUNDED"
			: state.status === "IN_PROGRESS" || state.status === "VERIFIED" ? "HELD" : "NONE",
		operator: payeeOperator === null ? null : { id: payeeOperator, handle: accepted?.handle ?? payeeOperator },
		lines, paidCents: held?.cents ?? null,
		capture: state.status === "IN_PROGRESS" || state.status === "VERIFIED"
			? { orderId: state.escrow.capture.orderId, captureId: state.escrow.capture.captureId,
				payee: state.escrow.capture.payee, gross: state.escrow.capture.gross }
			: null,
		fee: fee ? { cents: fee.cents, processor: fee.processor, acquit: fee.acquit } : null,
		payout: state.status === "PAID" ? { paid: state.release.paid, payoutItemId: state.release.payoutItemId,
			captureId: state.release.captureId, releasedAt: state.release.at, authority: state.releaseAuthority ?? null } : null,
		receipt: state.status === "PAID" ? { id: state.receipt.id, paid: state.receipt.paid, releasedAt: state.receipt.releasedAt } : null,
		attempts };
}

// ---- the book's totals -------------------------------------------------------------------------

/** The book's totals, the ledger's own arithmetic so every reader sums it the same way: holds
 * count on jobs still in escrow, and every release, refund, and fee the stored book carries. */
export function platformEscrowTotals(jobs: readonly PlatformJobLedger[]): {
	readonly held: number; readonly released: number; readonly refunded: number; readonly fees: number;
} {
	let held = 0;
	let released = 0;
	let refunded = 0;
	let fees = 0;
	for (const job of jobs) {
		for (const line of job.lines) {
			if (line.kind === "RELEASED") released += line.cents;
			else if (line.kind === "REFUND") refunded += line.cents;
			else if (line.kind === "FEE") fees += line.cents;
			else if (line.kind === "HELD" && job.escrow === "HELD") held += line.cents;
		}
	}
	return { held, released, refunded, fees };
}

// ---- the platform's relational tables ----------------------------------------------------------
// One read of the stored rows, projected into the seven tables the platform dashboards query. Every
// money column is integer cents, and every id is the store's own, so a relation joins on the same
// value the book holds. A projection only: nothing here writes, and the book stays the source.

/** A job's place on the funnel, numbered so the labels sort into the pipeline's order. */
export type PlatformStage = "1 Posted" | "2 Bid" | "3 Funded" | "4 Verified" | "5 Paid" | "6 Refunded" | "7 Closed";

export type PlatformJobRow = {
	readonly jobId: JobId;
	readonly title: string;
	readonly tenant: VisitorId | null;
	readonly clientId: ClientId;
	readonly status: JobStatus;
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	readonly stage: PlatformStage;
	readonly operatorId: OperatorId | null;
	readonly operatorHandle: string | null;
	readonly openedAt: Instant;
	readonly releasedAt: Instant | null;
	/** Independent operator bids only: the House bid is the quality bar, not a competing bid. */
	readonly bidCount: number;
	readonly attemptCount: number;
	/** The gross the capture held, on any job that holds or held escrow. Zero before a capture. */
	readonly grossCents: number;
	/** The escrow still held, on a HELD job alone. */
	readonly heldCents: number;
	readonly releasedCents: number;
	readonly feeCents: number;
	readonly refundedCents: number;
};

export type PlatformBidRow = {
	readonly bidId: string;
	readonly jobId: JobId;
	readonly operatorId: OperatorId;
	readonly handle: string;
	readonly kind: "INDEPENDENT" | "HOUSE";
	readonly status: string;
	readonly priceCents: number;
	readonly etaHours: number;
	readonly placedAt: Instant;
};

/** One judged attempt, keyed by its job and ordinal. The stored attempt keeps no submit time, so none is served. */
export type PlatformVerdictRow = {
	readonly verdictId: string;
	readonly jobId: JobId;
	readonly ordinal: number;
	readonly result: "VERIFIED" | "REJECTED";
	/** 1 when the attempt passed, 0 otherwise, so a verified count is a sum. */
	readonly verified: 0 | 1;
	/** 1 when the rejection named the frozen tests, 0 otherwise. */
	readonly tamper: 0 | 1;
	readonly reasonCount: number;
	readonly at: Instant;
};

/** One line of the stored book: a hold, a release, a fee, or a refund. */
export type PlatformLedgerEntryRow = {
	readonly entryId: string;
	readonly jobId: JobId;
	readonly kind: LedgerLine["kind"];
	readonly cents: number;
	readonly at: Instant;
	readonly captureId: CaptureId | null;
	readonly operatorId: OperatorId | null;
	readonly processorCents: number | null;
	readonly acquitCents: number | null;
};

/** One PayPal capture, the object an escrow was taken on. Keyed by the capture id, so a ledger line joins to it once. */
export type PlatformPayPalEventRow = {
	readonly captureId: CaptureId;
	readonly jobId: JobId;
	/** Null once the job settled: the store keeps the capture's order only while escrow is held. */
	readonly orderId: OrderId | null;
	readonly merchant: MerchantId;
	readonly state: "CAPTURED" | "RELEASED" | "REFUNDED";
	readonly grossCents: number;
	readonly refundId: string | null;
	readonly refundedCents: number | null;
	readonly payoutItemId: string | null;
	readonly releasedAt: Instant | null;
};

export type PlatformOperatorRow = {
	readonly operatorId: OperatorId;
	readonly handle: string;
	readonly kind: "INDEPENDENT" | "HOUSE";
	/** Null for an operator the store has no row for, known only from a bid. */
	readonly payoutReadiness: "NOT_STARTED" | "AWAITING_CONSENT" | "READY" | null;
	readonly paidReceipts: number;
};

/** A client's jobs. The tenant rides on each job row, so the client row carries no tenant of its own. */
export type PlatformClientRow = { readonly clientId: ClientId; readonly jobCount: number };

export type PlatformTables = {
	readonly jobs: readonly PlatformJobRow[];
	readonly bids: readonly PlatformBidRow[];
	readonly verdicts: readonly PlatformVerdictRow[];
	readonly ledger_entries: readonly PlatformLedgerEntryRow[];
	readonly paypal_events: readonly PlatformPayPalEventRow[];
	readonly operators: readonly PlatformOperatorRow[];
	readonly clients: readonly PlatformClientRow[];
};

/** The capture a job's money sits on, as the stored state names it, or null before any capture. */
function captureOf(row: JobRow): Omit<PlatformPayPalEventRow, "grossCents"> | null {
	const state = row.state;
	if (state.status === "IN_PROGRESS" || state.status === "VERIFIED") {
		const capture = state.escrow.capture;
		return { captureId: capture.captureId, jobId: row.id, orderId: capture.orderId, merchant: capture.payee, state: "CAPTURED",
			refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null };
	}
	if (state.status === "OPEN" && state.phase.kind === "FUNDING" && state.phase.checkout.phase === "REFUND_PENDING") {
		const capture = state.phase.checkout.escrow.capture;
		return { captureId: capture.captureId, jobId: row.id, orderId: capture.orderId, merchant: capture.payee, state: "CAPTURED",
			refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null };
	}
	if (state.status === "PAID") {
		return { captureId: state.release.captureId, jobId: row.id, orderId: null, merchant: state.payee.payee, state: "RELEASED",
			refundId: null, refundedCents: null, payoutItemId: state.release.payoutItemId, releasedAt: state.release.at };
	}
	if (state.status === "REFUNDED") {
		return { captureId: state.refund.captureId, jobId: row.id, orderId: null, merchant: state.payee.payee, state: "REFUNDED",
			refundId: state.refund.refundId, refundedCents: state.refund.refunded, payoutItemId: null, releasedAt: null };
	}
	return null;
}

/** A job's funnel stage. The funnel counts each job once, at the furthest stage it has reached. */
function stageOf(row: JobRow, independentBids: number): PlatformStage {
	const state = row.state;
	if (state.status === "PAID") return "5 Paid";
	if (state.status === "VERIFIED") return "4 Verified";
	if (state.status === "IN_PROGRESS") return "3 Funded";
	if (state.status === "REFUNDED") return "6 Refunded";
	if (state.status === "CLOSED") return "7 Closed";
	return independentBids === 0 && state.phase.kind === "BIDDING" ? "1 Posted" : "2 Bid";
}

/**
 * Projects the stored rows into the platform tables. `receipts` is the per-operator paid receipt
 * count the operator view already reads. An operator a bid names but the store has no row for is
 * still listed, so every bid and job joins to an operator.
 */
export function platformTables(rows: readonly JobRow[], operators: readonly OperatorRow[],
	receipts: ReadonlyMap<OperatorId, number>): PlatformTables {
	const jobs: PlatformJobRow[] = [];
	const bids: PlatformBidRow[] = [];
	const verdicts: PlatformVerdictRow[] = [];
	const entries: PlatformLedgerEntryRow[] = [];
	const events: PlatformPayPalEventRow[] = [];
	const known = new Map<OperatorId, PlatformOperatorRow>();
	for (const op of operators) {
		known.set(op.id, { operatorId: op.id, handle: op.handle, kind: op.kind, payoutReadiness: op.payouts.kind,
			paidReceipts: receipts.get(op.id) ?? 0 });
	}
	const clients = new Map<ClientId, number>();
	for (const row of rows) {
		const view = platformJobLedger(row);
		const capture = captureOf(row);
		const independentBids = row.bids.filter(bid => bid.kind === "INDEPENDENT").length;
		const held = view.lines.find(line => line.kind === "HELD")?.cents ?? 0;
		const released = view.lines.filter(line => line.kind === "RELEASED").reduce((sum, line) => sum + line.cents, 0);
		const refunded = view.lines.filter(line => line.kind === "REFUND").reduce((sum, line) => sum + line.cents, 0);
		jobs.push({ jobId: row.id, title: row.title, tenant: row.tenant ?? null, clientId: row.client, status: view.status,
			escrow: view.escrow, stage: stageOf(row, independentBids), operatorId: view.operator?.id ?? null,
			operatorHandle: view.operator?.handle ?? null, openedAt: row.openedAt,
			releasedAt: view.payout?.releasedAt ?? null, bidCount: independentBids, attemptCount: view.attempts.length,
			grossCents: view.escrow === "NONE" ? 0 : held, heldCents: view.escrow === "HELD" ? held : 0,
			releasedCents: released, feeCents: view.fee?.cents ?? 0, refundedCents: refunded });
		for (const bid of row.bids) {
			bids.push({ bidId: bid.id, jobId: row.id, operatorId: bid.operator, handle: bid.handle, kind: bid.kind, status: bid.status,
				priceCents: bid.price, etaHours: bid.eta, placedAt: bid.placedAt });
			if (!known.has(bid.operator)) {
				known.set(bid.operator, { operatorId: bid.operator, handle: bid.handle, kind: bid.kind, payoutReadiness: null,
					paidReceipts: receipts.get(bid.operator) ?? 0 });
			}
		}
		for (const attempt of view.attempts) {
			verdicts.push({ verdictId: `${row.id}#${attempt.ordinal}`, jobId: row.id, ordinal: attempt.ordinal, result: attempt.result,
				verified: attempt.result === "VERIFIED" ? 1 : 0, tamper: attempt.tamper ? 1 : 0, reasonCount: attempt.reasons.length,
				at: attempt.at });
		}
		view.lines.forEach((line, index) => {
			entries.push({ entryId: `${row.id}#${index}`, jobId: row.id, kind: line.kind, cents: line.cents, at: line.at,
				captureId: capture?.captureId ?? null, operatorId: view.operator?.id ?? null,
				processorCents: line.kind === "FEE" ? line.processor : null, acquitCents: line.kind === "FEE" ? line.acquit : null });
		});
		if (capture) events.push({ ...capture, grossCents: held });
		clients.set(row.client, (clients.get(row.client) ?? 0) + 1);
	}
	return {
		jobs,
		bids,
		verdicts,
		ledger_entries: entries,
		paypal_events: events,
		operators: [...known.values()],
		clients: [...clients].map(([clientId, jobCount]) => ({ clientId, jobCount })),
	};
}
