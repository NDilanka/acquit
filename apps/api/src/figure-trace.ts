// A Studio figure traced to the money behind it. The ledger lines come from the same core function the
// KPI tiles sum. Each line's PayPal status comes from the A1.3 reconciliation rows for that entry id, so
// this file reads no PayPal object of its own. The explain route and the ask tool both call it.

import { figureLines, type FigureId, type FigureJob, type FigureLineRow } from "../../../packages/core/src/explain.ts";
import type { ReconciledRow, ReconcileStatus } from "../../../packages/core/src/reconcile.ts";
import type { LedgerTables, ReconciliationBody } from "./reconciliation.ts";

/** The PayPal object a line names, and what PayPal answered for it. `id` is null when the line names none. */
export type TracePayPal = {
	readonly id: string | null;
	readonly status: ReconcileStatus;
	readonly observedCents: number | null;
	readonly note: string | null;
};

export type TracedLine = FigureLineRow & { readonly paypal: TracePayPal };

export type FigureTrace = {
	readonly figure: FigureId;
	readonly label: string;
	readonly totalCents: number;
	readonly lines: readonly TracedLine[];
};

export type TraceDeps = {
	readonly platformView: () => Promise<readonly FigureJob[]>;
	readonly platformTables: () => Promise<LedgerTables>;
	/** The PayPal reconciliation the dashboard's card reads. Null when this deployment has no PayPal credentials. */
	readonly reconcile: ((tables: LedgerTables, nowMs: number) => Promise<ReconciliationBody>) | null;
	readonly nowMs: () => number;
};

const NOT_CONFIGURED = "PayPal is not configured on this deployment, so this line was not checked.";
const COULD_NOT_READ = "PayPal could not be read just now, so this line was not checked.";
const NOT_IN_READ = "This line is not in the PayPal read.";

export async function traceFigure(deps: TraceDeps, figure: FigureId): Promise<FigureTrace> {
	const rows = figureLines(await deps.platformView(), figure);
	// A figure with no lines has no PayPal object to check, so it makes no PayPal read at all.
	if (rows.lines.length === 0) return { figure: rows.figure, label: rows.label, totalCents: rows.totalCents, lines: [] };
	const byEntry = await reconciledByEntry(deps);
	return { figure: rows.figure, label: rows.label, totalCents: rows.totalCents,
		lines: rows.lines.map(line => ({ ...line, paypal: payPalOf(line.entryId, byEntry) })) };
}

type Reconciled = { readonly rows: ReadonlyMap<string, ReconciledRow> } | { readonly unavailable: string };

async function reconciledByEntry(deps: TraceDeps): Promise<Reconciled> {
	if (deps.reconcile === null) return { unavailable: NOT_CONFIGURED };
	const tables = await deps.platformTables();
	try {
		const body = await deps.reconcile(tables, deps.nowMs());
		return { rows: new Map(body.rows.map(row => [row.entryId, row] as const)) };
	} catch {
		return { unavailable: COULD_NOT_READ };
	}
}

function payPalOf(entryId: string, reconciled: Reconciled): TracePayPal {
	if ("unavailable" in reconciled) return { id: null, status: "NOT_CHECKED", observedCents: null, note: reconciled.unavailable };
	const row = reconciled.rows.get(entryId);
	if (row === undefined) return { id: null, status: "NOT_CHECKED", observedCents: null, note: NOT_IN_READ };
	return { id: row.objectId, status: row.status, observedCents: row.observedCents, note: row.note };
}
