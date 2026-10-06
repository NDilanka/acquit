// Pure escrow ledger in integer cents. No I/O. Mirrors scratch/bend2-ledger/ledger.bend.
//
// Laws:
//   paid book      RELEASED + FEE = HELD, exactly one RELEASED, no REFUND
//   refunded book  REFUND = HELD, no RELEASED, no FEE
//   never both     no book holds RELEASED and REFUND
//
// Credits never enter this file. credits.ts has its own unit brand.

import type { Branded, Instant, JobId, OperatorId } from "./ids.ts";

/** Non-negative safe integer. 420.00 USD is 42000. */
export type UsdCents = Branded<number, "UsdCents">;

/** Parses "420.00" without floating point. Rejects negatives, fractions of a cent, and unsafe integers. */
export function usd(decimal: string): UsdCents {
	if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) throw new Error("Invalid USD amount");
	const [whole, fraction = ""] = decimal.split(".");
	const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe USD amount");
	return Number(cents) as UsdCents;
}

export function formatUsd(amount: UsdCents): string {
	if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid cents");
	return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

export type HeldLine = { readonly kind: "HELD"; readonly cents: UsdCents; readonly at: Instant };
export type ReleasedLine = { readonly kind: "RELEASED"; readonly cents: UsdCents; readonly at: Instant };
/** processor + acquit = cents. The tutorial's 60.00 is 15.15 PayPal processing plus 44.85 Acquit. */
export type FeeLine = {
	readonly kind: "FEE";
	readonly cents: UsdCents;
	readonly processor: UsdCents;
	readonly acquit: UsdCents;
	readonly at: Instant;
};
export type RefundLine = { readonly kind: "REFUND"; readonly cents: UsdCents; readonly at: Instant };
export type LedgerLine = HeldLine | ReleasedLine | FeeLine | RefundLine;

// The only reachable books. "Released and refunded" has no constructor.
export type EmptyBook = readonly [];
export type HeldBook = readonly [HeldLine];
export type PaidBook = readonly [HeldLine, ReleasedLine, FeeLine];
export type RefundedBook = readonly [HeldLine, RefundLine];
export type EscrowBook = EmptyBook | HeldBook | PaidBook | RefundedBook;

/** Observed money facts, already parsed from PayPal by the adapter. Never predicted values. */
export type LedgerMove =
	| { readonly kind: "Hold"; readonly gross: UsdCents; readonly at: Instant }
	| {
		readonly kind: "Release";
		readonly operatorNet: UsdCents;
		readonly processorFee: UsdCents;
		readonly platformFee: UsdCents;
		readonly at: Instant;
	}
	| { readonly kind: "Refund"; readonly refunded: UsdCents; readonly at: Instant };

export type LedgerLaw = "conservation" | "one_release" | "refund_xor_payout" | "order";

export type LawBreak = {
	readonly kind: "LAW_BREAK";
	readonly law: LedgerLaw;
};

const LAW_TEXT: Record<LedgerLaw, string> = {
	conservation: "released plus fee equals held, or refund equals held",
	one_release: "no double release",
	refund_xor_payout: "one disposition",
	order: "hold, then one disposition",
};

export function lawText(law: LedgerLaw): string {
	return LAW_TEXT[law];
}

function cents(amount: UsdCents): boolean {
	return Number.isSafeInteger(amount) && amount >= 0;
}

function breakLaw(law: LedgerLaw): LawBreak {
	return { kind: "LAW_BREAK", law };
}

function reduceAny(book: EscrowBook, move: LedgerMove): EscrowBook | LawBreak {
	if (book.length === 0 && move.kind === "Hold") {
		if (!cents(move.gross) || move.gross <= 0) return breakLaw("conservation");
		return [{ kind: "HELD", cents: move.gross, at: move.at }];
	}
	if (book.length === 1 && book[0].kind === "HELD" && move.kind === "Release") {
		if (!cents(move.operatorNet) || !cents(move.processorFee) || !cents(move.platformFee)) return breakLaw("conservation");
		const fee = move.processorFee + move.platformFee;
		if (!Number.isSafeInteger(fee) || move.operatorNet + fee !== book[0].cents) return breakLaw("conservation");
		return [book[0], { kind: "RELEASED", cents: move.operatorNet, at: move.at },
			{ kind: "FEE", cents: fee as UsdCents, processor: move.processorFee, acquit: move.platformFee, at: move.at }];
	}
	if (book.length === 1 && book[0].kind === "HELD" && move.kind === "Refund") {
		if (!cents(move.refunded) || move.refunded !== book[0].cents) return breakLaw("conservation");
		return [book[0], { kind: "REFUND", cents: move.refunded, at: move.at }];
	}
	if (book.length === 3 && move.kind === "Release") return breakLaw("one_release");
	if ((book.length === 3 && move.kind === "Refund") || (book.length === 2 && move.kind === "Release")) return breakLaw("refund_xor_payout");
	return breakLaw("order");
}

export function reduceLedger(book: EmptyBook, move: Extract<LedgerMove, { kind: "Hold" }>): HeldBook | LawBreak;
export function reduceLedger(book: HeldBook, move: Extract<LedgerMove, { kind: "Release" }>): PaidBook | LawBreak;
export function reduceLedger(book: HeldBook, move: Extract<LedgerMove, { kind: "Refund" }>): RefundedBook | LawBreak;
export function reduceLedger(book: EscrowBook, move: LedgerMove): EscrowBook | LawBreak;
export function reduceLedger(book: EscrowBook, move: LedgerMove): EscrowBook | LawBreak {
	return reduceAny(book, move);
}

export function checkLaws(lines: readonly LedgerLine[]): "OPEN" | "PAID" | "REFUNDED" | LawBreak {
	let book: EscrowBook = [];
	// A stored book is parsed JSON, so the checker stays total: a line that is not a
	// book entry is an illegal sequence, never a TypeError.
	if (!Array.isArray(lines)) return breakLaw("order");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === null || typeof line !== "object") return breakLaw("order");
		let move: LedgerMove;
		let fee: FeeLine | undefined;
		switch (line.kind) {
			case "HELD": move = { kind: "Hold", gross: line.cents, at: line.at }; break;
			case "REFUND": move = { kind: "Refund", refunded: line.cents, at: line.at }; break;
			case "RELEASED": {
				const next = lines[index + 1];
				fee = next?.kind === "FEE" ? next : undefined;
				// The stored fee is untrusted JSON: the reducer gets exactly what was stored, so its own
				// safe-integer check names the law. Zeros never stand in for a stored component, because
				// a null read as a zero fee satisfies the sum and coerces in the split check instead of
				// failing. They stand in only for a missing FEE line, which is an order break itself.
				move = fee
					? { kind: "Release", operatorNet: line.cents, processorFee: fee.processor, platformFee: fee.acquit, at: line.at }
					: { kind: "Release", operatorNet: line.cents, processorFee: 0 as UsdCents, platformFee: 0 as UsdCents, at: line.at };
				break;
			}
			default: return breakLaw("order");
		}
		// Stop at the first illegal move, with the reducer's precedence (not aggregate sums).
		const nextBook: EscrowBook | LawBreak = reduceLedger(book, move);
		if ("kind" in nextBook) return nextBook;
		if (line.kind === "RELEASED") {
			if (!fee) return breakLaw("order");
			if (!cents(fee.cents) || fee.processor + fee.acquit !== fee.cents) return breakLaw("conservation");
			index++;
		}
		book = nextBook;
	}
	return book.length === 3 ? "PAID" : book.length === 2 ? "REFUNDED" : "OPEN";
}

/** Commercial terms. Client pays 5% on top. Operator gives up 10%. Acquit's 15% covers PayPal's fee. */
export type CommercialSplit = {
	readonly price: UsdCents;
	readonly clientFee: UsdCents;
	readonly operatorFee: UsdCents;
	readonly held: UsdCents;
	readonly operatorNet: UsdCents;
	readonly fee: UsdCents;
};

export function commercialSplit(price: UsdCents): CommercialSplit {
	// Integer basis points, half-up rounding to the cent.
	if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Invalid price");
	const round = (bps: number): UsdCents => Number((BigInt(price) * BigInt(bps) + 5000n) / 10000n) as UsdCents;
	const clientFee = round(500);
	const operatorFee = round(1000);
	const held = price + clientFee;
	if (!Number.isSafeInteger(held)) throw new Error("Unsafe total");
	return { price, clientFee, operatorFee, held: held as UsdCents,
		operatorNet: (price - operatorFee) as UsdCents, fee: (clientFee + operatorFee) as UsdCents };
}

/**
 * Acquit's own costs. Outside the escrow laws, because no escrow money funds them.
 * A variance arises when PayPal's observed processing fee differs from the quote at accept.
 */
export type TreasuryEntry =
	| {
		readonly kind: "PROCESSOR_FEE_VARIANCE";
		readonly jobId: JobId;
		readonly predicted: UsdCents;
		readonly observed: UsdCents;
		readonly at: Instant;
	}
	| { readonly kind: "REFUND_FEE_RETAINED"; readonly jobId: JobId; readonly cents: UsdCents; readonly at: Instant }
	| {
		readonly kind: "OPERATOR_REIMBURSEMENT_OWED";
		readonly jobId: JobId;
		readonly operator: OperatorId;
		readonly cents: UsdCents;
		readonly cause: "NET_BELOW_PROMISE" | "REFUND_DEBITED_OPERATOR";
		readonly at: Instant;
	};

export type ReleaseFacts = {
	readonly jobId: JobId;
	readonly operator: OperatorId;
	/** The operator net quoted at accept. */
	readonly promisedNet: UsdCents;
	/** The net the operator actually received, parsed from the provider's capture. */
	readonly observedNet: UsdCents;
	readonly predictedProcessorFee: UsdCents;
	readonly observedProcessorFee: UsdCents;
	readonly at: Instant;
};

export type RefundFacts = {
	readonly jobId: JobId;
	readonly operator: OperatorId;
	readonly retainedProcessorFee: UsdCents;
	readonly at: Instant;
};

export function releaseTreasury(facts: ReleaseFacts): readonly TreasuryEntry[] {
	if (!cents(facts.promisedNet) || !cents(facts.observedNet) || !cents(facts.predictedProcessorFee) || !cents(facts.observedProcessorFee)) throw new Error("Invalid treasury facts");
	const entries: TreasuryEntry[] = [];
	if (facts.observedProcessorFee !== facts.predictedProcessorFee) {
		entries.push({ kind: "PROCESSOR_FEE_VARIANCE", jobId: facts.jobId, predicted: facts.predictedProcessorFee, observed: facts.observedProcessorFee, at: facts.at });
	}
	// Compare the observed net with the promise directly: a fee-driven gap in what the operator receives is owed back.
	if (facts.observedNet < facts.promisedNet) {
		entries.push({ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId: facts.jobId, operator: facts.operator, cents: (facts.promisedNet - facts.observedNet) as UsdCents, cause: "NET_BELOW_PROMISE", at: facts.at });
	}
	return entries;
}

export function refundTreasury(facts: RefundFacts): readonly TreasuryEntry[] {
	if (!cents(facts.retainedProcessorFee) || facts.retainedProcessorFee <= 0) throw new Error("Invalid retained fee");
	return [
		{ kind: "REFUND_FEE_RETAINED", jobId: facts.jobId, cents: facts.retainedProcessorFee, at: facts.at },
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId: facts.jobId, operator: facts.operator, cents: facts.retainedProcessorFee, cause: "REFUND_DEBITED_OPERATOR", at: facts.at },
	];
}
