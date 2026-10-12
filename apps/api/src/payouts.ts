// The payouts route's read: one row per released job the operator was paid, read from the job's
// release evidence. A payout exists only where the book recorded one, so seeded receipt rows
// produce no payout row and a job's payout appears in its payee operator's list alone.

export type PayoutRowView = Record<string, unknown> & {
	readonly jobId: string;
	/** The referenced payout item the capture paid through (`GET /v1/payments/referenced-payouts-items/<id>`). */
	readonly payoutItemId: string;
	readonly captureId: string | null;
	readonly paid: number | null;
	readonly releasedAt: string | null;
	readonly releaseAuthority: string | null;
};

type PaidJobJson = {
	readonly contract?: { readonly definitionOfDone?: { readonly issue?: { readonly repository?: unknown } } };
	readonly state?: {
		readonly status?: unknown;
		readonly payee?: { readonly operator?: unknown };
		readonly release?: { readonly payoutItemId?: unknown; readonly captureId?: unknown; readonly paid?: unknown; readonly at?: unknown };
		readonly releaseAuthority?: unknown;
	};
};

export function operatorPayouts(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, operatorId: string, clientRepository: string): readonly PayoutRowView[] {
	const payouts: PayoutRowView[] = [];
	for (const row of db.prepare("SELECT id, json FROM jobs").all() as { id: string; json: string }[]) {
		const job = JSON.parse(String(row.json)) as PaidJobJson;
		if (job.state?.status !== "PAID" || job.state.payee?.operator !== operatorId) continue;
		const release = job.state.release;
		if (!release || typeof release.payoutItemId !== "string") continue;
		payouts.push({
			jobId: row.id,
			payoutItemId: release.payoutItemId,
			captureId: typeof release.captureId === "string" ? release.captureId : null,
			paid: typeof release.paid === "number" ? release.paid : null,
			releasedAt: typeof release.at === "string" ? release.at : null,
			releaseAuthority: typeof job.state.releaseAuthority === "string" ? job.state.releaseAuthority : null,
			repository: String(job.contract?.definitionOfDone?.issue?.repository ?? clientRepository),
		});
	}
	payouts.sort((left, right) => String(right.releasedAt ?? "").localeCompare(String(left.releasedAt ?? "")));
	return payouts;
}
