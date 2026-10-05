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

export type LawBreak = {
	readonly kind: "LAW_BREAK";
	readonly law: "conservation" | "one_release" | "refund_xor_payout" | "order";
};

export function reduceLedger(book: EmptyBook, move: Extract<LedgerMove, { kind: "Hold" }>): HeldBook | LawBreak;
export function reduceLedger(book: HeldBook, move: Extract<LedgerMove, { kind: "Release" }>): PaidBook | LawBreak;
export function reduceLedger(book: HeldBook, move: Extract<LedgerMove, { kind: "Refund" }>): RefundedBook | LawBreak;
export function reduceLedger(book: EscrowBook, move: LedgerMove): EscrowBook | LawBreak {
	// TODO Hold on empty gives [HELD gross].
	// TODO Release on held writes RELEASED operatorNet and FEE (processorFee + platformFee) as one pair.
	//      Break "conservation" unless operatorNet + processorFee + platformFee = HELD.
	// TODO Refund on held writes REFUND. Break "conservation" unless refunded = HELD.
	// TODO Any other pair breaks "order", "one_release", or "refund_xor_payout".
	if (book.length === 0 && move.kind === "Hold") {
		if (!Number.isSafeInteger(move.gross) || move.gross <= 0) return { kind: "LAW_BREAK", law: "conservation" };
		return [{ kind: "HELD", cents: move.gross, at: move.at }];
	}
	// Release and refund remain outside the walking skeleton.
	throw new Error("not implemented");
}

/** Same check as close() in ledger.bend. Used by property tests and the Bend2 demo parity check. */
export function checkLaws(lines: readonly LedgerLine[]): "OPEN" | "PAID" | "REFUNDED" | LawBreak {
	throw new Error("not implemented");
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
	// TODO Integer basis points, half-up rounding to the cent.
	// TODO held = price + clientFee (42000). operatorNet = price - operatorFee (36000).
	// TODO fee = clientFee + operatorFee (6000). Assert operatorNet + fee = held.
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
