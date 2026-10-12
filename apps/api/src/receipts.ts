// The receipts route's read. A receipt lives on its PAID job row; the receipts table is the book the
// House line counts from, so a row's source comes from that table and the deployment's seeded
// history rows (no job behind them) appear as display rows of their own.

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
	readonly state?: { readonly status?: unknown; readonly payee?: { readonly operator?: unknown }; readonly receipt?: StoredReceipt };
};

export function operatorReceipts(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, operatorId: string, clientRepository: string): readonly ReceiptRowView[] {
	const sources = new Map<string, string>();
	for (const row of db.prepare("SELECT id, source FROM receipts WHERE operator = ?").all(operatorId) as { id: string; source: string }[]) {
		sources.set(row.id, row.source);
	}
	const receipts: ReceiptRowView[] = [];
	for (const row of db.prepare("SELECT json FROM jobs").all() as { json: string }[]) {
		const job = JSON.parse(String(row.json)) as PaidJobJson;
		if (job.state?.status !== "PAID" || job.state.payee?.operator !== operatorId || !job.state.receipt) continue;
		receipts.push({ ...job.state.receipt,
			repository: String(job.contract?.definitionOfDone?.issue?.repository ?? clientRepository),
			source: sources.get(job.state.receipt.id) === "SEED" ? "SEED" : "JOB",
			passedVerifiedCi: true });
	}
	// A seeded row has no job behind it: the display row keeps only the facts the book holds.
	for (const row of db.prepare("SELECT id, paid, paid_at FROM receipts WHERE operator = ? AND job_id IS NULL").all(operatorId) as { id: string; paid: number; paid_at: string | null }[]) {
		receipts.push({ id: row.id, jobId: null, operator: operatorId, agent: null, pullRequest: null, mergeCommit: null,
			frozen: null, hidden: null, attemptsUsed: null, paid: null, releasedAt: row.paid_at,
			repository: null, source: "SEED", passedVerifiedCi: row.paid === 1 });
	}
	receipts.sort((left, right) => String(right.releasedAt ?? "").localeCompare(String(left.releasedAt ?? "")));
	return receipts;
}
