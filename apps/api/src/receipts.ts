// The receipts route's read. A receipt lives on its PAID job row; the receipts table is the book the
// House line counts from, so a row's source comes from that table and the deployment's seeded
// history rows (no job behind them) appear as display rows of their own.

import { resolveHiddenReveal } from "../../../packages/core/src/hidden-seal.ts";
import type { PrivateCaseReader } from "../../../packages/core/src/hidden-seal.ts";
import type { SealedHiddenCases } from "../../../packages/core/src/verifier.ts";

/** One row the receipts grid renders, exactly as the route serves it. */
export type ReceiptRowView = Record<string, unknown> & {
	readonly source: "SEED" | "JOB";
	/** Seeded rows carry the book's paid flag (passed verified CI); a settled job's receipt always passed. */
	readonly passedVerifiedCi: boolean;
};

type StoredReceipt = {
	readonly id: string;
	readonly jobId: string;
	readonly operator: string;
	readonly agent: string;
	readonly pullRequest: number;
	readonly mergeCommit: string;
	readonly frozen: { readonly expected: number; readonly passed: number };
	readonly hidden: { readonly expected: number; readonly passed: number };
	readonly attemptsUsed: number;
	readonly paid: number;
	readonly releasedAt: string;
};

type PaidJobJson = {
	readonly contract?: { readonly definitionOfDone?: { readonly issue?: { readonly repository?: unknown } } };
	readonly state?: { readonly status?: unknown; readonly payee?: { readonly operator?: unknown }; readonly receipt?: StoredReceipt;
		/** The stored book: its FEE and HELD lines name the job's fee and the gross the capture held. */
		readonly book?: readonly { readonly kind?: unknown; readonly cents?: unknown; readonly processor?: unknown; readonly acquit?: unknown }[] };
};

/** One book line the receipt card reads. A row stored before the line existed reads null there. */
function bookLine(state: PaidJobJson["state"], kind: "HELD" | "FEE"): { readonly cents: number; readonly processor: number | null; readonly acquit: number | null } | null {
	const line = state?.book?.find(entry => entry?.kind === kind);
	if (!line || typeof line.cents !== "number") return null;
	return { cents: line.cents, processor: typeof line.processor === "number" ? line.processor : null, acquit: typeof line.acquit === "number" ? line.acquit : null };
}

/** The seal the frozen manifest carries. The jobs row keeps the contract as it was opened, so the seal is read from job_manifests, as the store's readers read it. */
function frozenSealOf(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, jobId: string): SealedHiddenCases | null {
	const row = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(jobId) as { json: string } | undefined;
	if (!row) return null;
	return (JSON.parse(String(row.json)) as { sealedHiddenCases?: SealedHiddenCases }).sealedHiddenCases ?? null;
}

export function operatorReceipts(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, operatorId: string, clientRepository: string,
	privateCases: PrivateCaseReader): readonly ReceiptRowView[] {
	const sources = new Map<string, string>();
	for (const row of db.prepare("SELECT id, source FROM receipts WHERE operator = ?").all(operatorId) as { id: string; source: string }[]) {
		sources.set(row.id, row.source);
	}
	const receipts: ReceiptRowView[] = [];
	for (const row of db.prepare("SELECT id, json FROM jobs").all() as { id: string; json: string }[]) {
		const job = JSON.parse(String(row.json)) as PaidJobJson;
		if (job.state?.status !== "PAID" || job.state.payee?.operator !== operatorId || !job.state.receipt) continue;
		const held = bookLine(job.state, "HELD");
		const fee = bookLine(job.state, "FEE");
		const hiddenReveal = resolveHiddenReveal({ id: String(row.id), status: "PAID", sealed: frozenSealOf(db, String(row.id)) }, privateCases);
		receipts.push({ ...job.state.receipt,
			repository: String(job.contract?.definitionOfDone?.issue?.repository ?? clientRepository),
			source: sources.get(job.state.receipt.id) === "SEED" ? "SEED" : "JOB",
			passedVerifiedCi: true,
			// The receipt card's own fields: the gross the capture held and the fee the book took, so
			// the card's numbers come from the same row the route serves.
			grossPaid: held?.cents ?? null,
			fee: fee?.cents ?? null,
			feeSplit: fee ? { processor: fee.processor, acquit: fee.acquit } : null,
			// The same reveal the job route serves for this job, resolved by the one core function.
			hiddenReveal,
			result: "VERIFIED" });
	}
	// A seeded row has no job behind it: the display row keeps only the facts the book holds.
	for (const row of db.prepare("SELECT id, paid, paid_at FROM receipts WHERE operator = ? AND job_id IS NULL").all(operatorId) as { id: string; paid: number; paid_at: string | null }[]) {
		receipts.push({ id: row.id, jobId: null, operator: operatorId, agent: null, pullRequest: null, mergeCommit: null,
			frozen: null, hidden: null, attemptsUsed: null, paid: null, releasedAt: row.paid_at,
			repository: null, source: "SEED", passedVerifiedCi: row.paid === 1,
			grossPaid: null, fee: null, feeSplit: null, hiddenReveal: null, result: null });
	}
	receipts.sort((left, right) => String(right.releasedAt ?? "").localeCompare(String(left.releasedAt ?? "")));
	return receipts;
}
