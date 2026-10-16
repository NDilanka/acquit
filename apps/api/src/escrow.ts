import type { JobView } from "../../../packages/core/src/acquit.ts";
import { commercialSplit } from "../../../packages/core/src/ledger.ts";

/** One escrow hold the operator's release will pay: the operator's net, in cents. */
export type OperatorEscrowRow = { readonly jobId: string; readonly cents: number };

/**
 * The operator's share of each job the escrow holds for them. The release pays the net after the operator
 * fee, not the client's gross, so the number is the net. A refund in flight is not the operator's money.
 */
export function operatorEscrow(jobs: readonly JobView[], operatorId: string): OperatorEscrowRow[] {
	const rows: OperatorEscrowRow[] = [];
	for (const job of jobs) {
		if (job.lockedTo !== operatorId || job.escrow !== "HELD" || job.phase === "REFUND_PENDING") continue;
		const bid = [...job.bids.operators, ...(job.bids.house ? [job.bids.house] : [])].find(b => b.operator === operatorId);
		if (!bid) continue;
		rows.push({ jobId: job.id, cents: commercialSplit(bid.price).operatorNet });
	}
	return rows;
}
