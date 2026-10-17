// The escrow figures the Studio dashboards show, and the ledger lines that make each one up. The KPI
// tiles, the conserves card, the explain route, and the ask tool all read these functions, so a figure
// and the lines behind it cannot drift. Pure, with no runtime import: the browser runs this file too.

/** One ledger line, as a figure reads it. A PlatformJobLedger line satisfies this shape. */
export type FigureLine = {
	readonly kind: "HELD" | "RELEASED" | "FEE" | "REFUND";
	readonly cents: number;
	readonly at: string;
};

/** One job, as a figure reads it. A PlatformJobLedger satisfies this shape. */
export type FigureJob = {
	readonly jobId: string;
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	readonly lines: readonly FigureLine[];
	readonly receipt: { readonly id: string } | null;
};

export const FIGURE_IDS = ["held", "released", "refunded", "fees", "paid-by-clients"] as const;
export type FigureId = (typeof FIGURE_IDS)[number];

export function isFigureId(value: unknown): value is FigureId {
	return typeof value === "string" && (FIGURE_IDS as readonly string[]).includes(value);
}

/** One ledger line a figure names. `receiptId` is set only on a PAID job, where the receipt is. */
export type FigureLineRow = {
	readonly entryId: string;
	readonly jobId: string;
	readonly kind: FigureLine["kind"];
	readonly cents: number;
	readonly at: string;
	readonly receiptId: string | null;
};

export type FigureLines = {
	readonly figure: FigureId;
	readonly label: string;
	readonly totalCents: number;
	readonly lines: readonly FigureLineRow[];
};

/** A line's id: its job, and its position in that job's stored book. The platform tables name each entry this way too. */
export function ledgerEntryId(jobId: string, index: number): string {
	return `${jobId}#${index}`;
}

const RULES: Record<FigureId, { readonly label: string; readonly selects: (job: FigureJob, line: FigureLine) => boolean }> = {
	held: { label: "Held escrow", selects: (job, line) => job.escrow === "HELD" && line.kind === "HELD" },
	released: { label: "Released", selects: (_job, line) => line.kind === "RELEASED" },
	refunded: { label: "Refunded", selects: (_job, line) => line.kind === "REFUND" },
	fees: { label: "Fees collected", selects: (_job, line) => line.kind === "FEE" },
	// A hold on a released job is what the client paid; a hold on a job still in escrow is not yet paid out.
	"paid-by-clients": { label: "Paid by clients", selects: (job, line) => job.escrow === "RELEASED" && line.kind === "HELD" },
};

/** The words a figure carries on every screen: the Studio tiles, the Explain panel, and the ask tool's rows. */
export const FIGURE_LABELS: Readonly<Record<FigureId, string>> = {
	held: RULES.held.label,
	released: RULES.released.label,
	refunded: RULES.refunded.label,
	fees: RULES.fees.label,
	"paid-by-clients": RULES["paid-by-clients"].label,
};

/** The lines that make up one figure, and their sum. The figure's value is this sum, by construction. */
export function figureLines(jobs: readonly FigureJob[], figure: FigureId): FigureLines {
	const rule = RULES[figure];
	const lines: FigureLineRow[] = [];
	let totalCents = 0;
	for (const job of jobs) {
		job.lines.forEach((line, index) => {
			if (!rule.selects(job, line)) return;
			lines.push({ entryId: ledgerEntryId(job.jobId, index), jobId: job.jobId, kind: line.kind, cents: line.cents, at: line.at,
				receiptId: job.receipt?.id ?? null });
			totalCents += line.cents;
		});
	}
	return { figure, label: rule.label, totalCents, lines };
}

export function figureCents(jobs: readonly FigureJob[], figure: FigureId): number {
	return figureLines(jobs, figure).totalCents;
}
