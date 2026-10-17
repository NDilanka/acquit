// The receipts route's read. A receipt lives on its PAID job row; the receipts table is the book the
// House line counts from, so a row's source comes from that table and the deployment's seeded
// history rows (no job behind them) appear as display rows of their own.

import { resolveHiddenReveal } from "../../../packages/core/src/hidden-seal.ts";
import type { PrivateCaseReader } from "../../../packages/core/src/hidden-seal.ts";
import { TERMS } from "../../../packages/core/src/job.ts";
import { PUBLISHED_SCORE_CARD, reasonCode } from "../../../packages/core/src/score-card.ts";
import type { ScoreCard } from "../../../packages/core/src/score-card.ts";
import type { HiddenCase, RejectReason, SealedHiddenCases } from "../../../packages/core/src/verifier.ts";

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

/** One judged attempt as the public receipt shows it. A reason names its closed code only, never the test ids it failed. */
export type PublicAttempt = {
	readonly ordinal: number;
	readonly result: "VERIFIED" | "REJECTED";
	readonly at: string;
	readonly frozen: { readonly expected: number; readonly passed: number } | null;
	readonly hidden: { readonly expected: number; readonly passed: number } | null;
	readonly reasons: readonly string[];
};

/** The public receipt body. Every field is one a non-party may read; see docs/architecture/http.md for the reasons. */
export type PublicReceipt = {
	readonly receipt: {
		readonly id: string;
		readonly title: string | null;
		readonly issue: number | null;
		readonly source: "SEED" | "JOB";
		/** A judge scenario started this job, so its agent was scripted. The page labels that Simulated. */
		readonly scripted: boolean;
		readonly releasedAt: string;
		readonly releaseAuthority: string | null;
		readonly operator: { readonly handle: string | null; readonly label: "INDEPENDENT" | "HOUSE" | null };
		readonly money: { readonly heldCents: number | null; readonly paidCents: number; readonly feeCents: number | null;
			readonly processorFeeCents: number | null; readonly acquitFeeCents: number | null };
		readonly verdict: { readonly attemptsUsed: number; readonly attemptsAllowed: number; readonly frozen: { readonly expected: number; readonly passed: number };
			readonly hidden: { readonly expected: number; readonly passed: number }; readonly pullRequest: number; readonly mergeCommit: string;
			readonly history: readonly PublicAttempt[] };
		readonly paypal: { readonly captureId: string | null; readonly payoutItemId: string | null; readonly feeBatchId: string | null };
		/** Null for a job that ran only the fixture's curated hidden tests, which are never published. */
		readonly hiddenCases: { readonly committedDigest: string; readonly committedAt: string | null;
			readonly revealed: { readonly salt: string; readonly cases: readonly HiddenCase[] } | null } | null;
		readonly scoreCard: ScoreCard;
	};
};

type PaidRow = {
	readonly title?: unknown;
	readonly contract?: { readonly definitionOfDone?: { readonly issue?: { readonly number?: unknown } } };
	readonly bids?: readonly { readonly id?: unknown; readonly handle?: unknown; readonly kind?: unknown }[];
	readonly state?: {
		readonly status?: unknown;
		readonly payee?: { readonly bidId?: unknown; readonly operator?: unknown };
		readonly receipt?: StoredReceipt;
		readonly book?: readonly { readonly kind?: unknown; readonly cents?: unknown; readonly processor?: unknown; readonly acquit?: unknown }[];
		readonly release?: { readonly payoutItemId?: unknown; readonly captureId?: unknown };
		readonly releaseAuthority?: unknown;
		readonly history?: readonly { readonly ordinal?: unknown; readonly verdict?: Record<string, unknown> }[];
		readonly treasury?: readonly { readonly kind?: unknown; readonly batchId?: unknown }[];
	};
};

/** A tally the stored verdict carries, or null when the row holds none. */
function tallyOf(value: unknown): { readonly expected: number; readonly passed: number } | null {
	const tally = value as { expected?: unknown; passed?: unknown } | null | undefined;
	return typeof tally?.expected === "number" && typeof tally.passed === "number" ? { expected: tally.expected, passed: tally.passed } : null;
}

function attemptOf(entry: { readonly ordinal?: unknown; readonly verdict?: Record<string, unknown> }): PublicAttempt | null {
	const verdict = entry.verdict;
	if (!verdict || (verdict.result !== "VERIFIED" && verdict.result !== "REJECTED")) return null;
	const reasons = Array.isArray(verdict.reasons) ? verdict.reasons as RejectReason[] : [];
	return { ordinal: Number(entry.ordinal), result: verdict.result, at: String(verdict.at ?? ""),
		frozen: tallyOf(verdict.frozen), hidden: tallyOf(verdict.hidden),
		reasons: reasons.filter(reason => typeof reason?.kind === "string").map(reasonCode) };
}

/** The digest a sealed job committed at approval, and the instant the approval claimed it. Only an approved draft has one. */
function committedAtOf(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, jobId: string): string | null {
	const row = db.prepare("SELECT updated_at FROM job_scoping WHERE job_id = ? AND status = 'APPROVED'").get(jobId) as { updated_at: string } | undefined;
	return row ? String(row.updated_at) : null;
}

/**
 * The public receipt for the PAID job that settled under this receipt id. Null for every other row:
 * an unknown id, an unpaid job, and a job whose receipt names another id all answer the same way.
 * The receipt id is the capability: the job id is visible to every signed-in viewer while a job is OPEN.
 */
export function publicReceipt(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, receiptId: string,
	privateCases: PrivateCaseReader): PublicReceipt | null {
	const found = db.prepare("SELECT id, json FROM jobs WHERE json_extract(json, '$.state.status') = 'PAID' AND json_extract(json, '$.state.receipt.id') = ?")
		.get(receiptId) as { id: string; json: string } | undefined;
	if (!found) return null;
	const jobId = String(found.id);
	const job = JSON.parse(String(found.json)) as PaidRow;
	const state = job.state;
	const receipt = state?.receipt;
	if (!state || !receipt || receipt.id !== receiptId) return null;
	const bid = job.bids?.find(entry => entry.id === state.payee?.bidId);
	const held = bookLine(state, "HELD");
	const fee = bookLine(state, "FEE");
	const source = db.prepare("SELECT source FROM receipts WHERE id = ?").get(receiptId) as { source: string } | undefined;
	const batch = state.treasury?.find(entry => entry?.kind === "PAYOUT_FEE_PAID");
	const issue = job.contract?.definitionOfDone?.issue?.number;
	const sealed = frozenSealOf(db, jobId);
	const reveal = sealed === null ? null : resolveHiddenReveal({ id: jobId, status: "PAID", sealed }, privateCases);
	return { receipt: {
		id: receiptId,
		title: typeof job.title === "string" ? job.title : null,
		issue: typeof issue === "number" ? issue : null,
		source: source?.source === "SEED" ? "SEED" : "JOB",
		// scenario_runs is a bounded snapshot table that evicts old runs; the cleanup journal keeps every committed run.
		scripted: db.prepare(`SELECT 1 FROM scenario_cleanup WHERE job_id = ?
			UNION ALL SELECT 1 FROM scenario_runs WHERE job_id = ? LIMIT 1`).get(jobId, jobId) !== undefined,
		releasedAt: receipt.releasedAt,
		releaseAuthority: typeof state.releaseAuthority === "string" ? state.releaseAuthority : null,
		operator: { handle: typeof bid?.handle === "string" ? bid.handle : null,
			label: bid?.kind === "HOUSE" || bid?.kind === "INDEPENDENT" ? bid.kind : null },
		money: { heldCents: held?.cents ?? null, paidCents: receipt.paid, feeCents: fee?.cents ?? null,
			processorFeeCents: fee?.processor ?? null, acquitFeeCents: fee?.acquit ?? null },
		verdict: { attemptsUsed: receipt.attemptsUsed, attemptsAllowed: TERMS.maxAttempts, frozen: receipt.frozen, hidden: receipt.hidden,
			pullRequest: receipt.pullRequest, mergeCommit: receipt.mergeCommit,
			history: (state.history ?? []).map(attemptOf).filter((attempt): attempt is PublicAttempt => attempt !== null) },
		paypal: { captureId: typeof state.release?.captureId === "string" ? state.release.captureId : null,
			payoutItemId: typeof state.release?.payoutItemId === "string" ? state.release.payoutItemId : null,
			feeBatchId: typeof batch?.batchId === "string" ? batch.batchId : null },
		hiddenCases: sealed === null ? null : { committedDigest: sealed.digest, committedAt: committedAtOf(db, jobId),
			revealed: reveal === null ? null : { salt: reveal.salt, cases: reveal.cases } },
		scoreCard: { ...PUBLISHED_SCORE_CARD },
	} };
}
