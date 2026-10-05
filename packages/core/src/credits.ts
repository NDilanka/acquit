// Pure bid-credit reducer. No I/O. Credits are a closed-loop unit with their own brand,
// so no credit amount can reach ledger.ts. There is no transfer or cash-out move.

import type { BidId, Branded, Instant, OperatorId, OrderId, Version } from "./ids";

export type Credits = Branded<number, "Credits">;
/** Monday 00:00 UTC that starts the week, as "2026-W44". */
export type WeekId = Branded<string, "IsoWeek">;

export const BID_COST = 10 as Credits;
export const WEEKLY_BASE = 30 as Credits;
export const PER_RECEIPT = 10 as Credits;
export const WEEKLY_CAP = 100 as Credits;
export const CREDIT_PRICE_CENTS = 15;

/** Allowance expires at the next grant. Purchased credits never expire. */
export type CreditSplit = { readonly allowance: Credits; readonly purchased: Credits };

export type ReturnReason = "CLIENT_CANCEL" | "NO_CLIENT_RESPONSE";

/** Each line has a unique key per operator. A replayed move appends nothing. */
export type CreditLine =
	| { readonly kind: "GRANT"; readonly key: `grant:${WeekId}`; readonly credits: Credits; readonly at: Instant }
	| { readonly kind: "EXPIRE"; readonly key: `expire:${WeekId}`; readonly credits: Credits; readonly at: Instant }
	| { readonly kind: "SPEND"; readonly key: `spend:${BidId}`; readonly split: CreditSplit; readonly at: Instant }
	| {
		readonly kind: "RETURN";
		readonly key: `return:${BidId}`;
		readonly split: CreditSplit;
		readonly reason: ReturnReason;
		readonly at: Instant;
	}
	| { readonly kind: "PURCHASE"; readonly key: `purchase:${OrderId}`; readonly credits: Credits; readonly at: Instant };

export type CreditAccount = {
	readonly operator: OperatorId;
	readonly version: Version;
	readonly balance: CreditSplit;
	readonly lines: readonly CreditLine[];
};

export type CreditMove =
	| { readonly kind: "Grant"; readonly week: WeekId; readonly paidReceipts: number; readonly at: Instant }
	| { readonly kind: "Spend"; readonly bid: BidId; readonly at: Instant }
	| { readonly kind: "Return"; readonly bid: BidId; readonly reason: ReturnReason; readonly at: Instant }
	| { readonly kind: "Purchase"; readonly order: OrderId; readonly credits: Credits; readonly at: Instant };

/** min(100, 30 + 10 * paid receipts). Counted at the Monday boundary, never retroactively mid-week. */
export function weeklyAllowance(paidReceipts: number): Credits {
	throw new Error("not implemented");
}

export function reduceCredits(account: CreditAccount, move: CreditMove): CreditAccount | "INSUFFICIENT_CREDITS" {
	// TODO Grant writes EXPIRE for the unspent allowance of the previous week, then GRANT weeklyAllowance(paidReceipts).
	// TODO Spend takes exactly BID_COST, allowance first, then purchased. House bids never call Spend.
	// TODO Return copies the SPEND split for that bid back into the same buckets. No SPEND means no-op.
	//      A returned allowance credit may exceed the cap. The cap limits grants, not balance.
	// TODO Every move checks its key against lines first, so a replay returns the account unchanged.
	throw new Error("not implemented");
}
