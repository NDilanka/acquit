// The platform ledger's read: every job's money lines across all tenants, for the platform role's
// dashboards alone. A projection, not a command path: it reads the stored books and serves the same
// facts the job view serves, with the one-tenant rule lifted for this one query and role.

import type { ClientId, Instant, JobId, JobStatus, OperatorId, UsdCents, VisitorId } from "./acquit.ts";
import type { CaptureId, MerchantId, OrderId } from "./ids.ts";
import { attemptView, storedBook } from "./job.ts";
import type { JobRow } from "./job.ts";
import type { LedgerLine } from "./ledger.ts";
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
