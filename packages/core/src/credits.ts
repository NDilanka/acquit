// Pure bid-credit reducer. No I/O. Credits are a closed-loop unit with their own brand,
// so no credit amount can reach ledger.ts. There is no transfer or cash-out move.

import type { BidId, Branded, Instant, OperatorId, OrderId, Version } from "./ids.ts";

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
	if (!Number.isSafeInteger(paidReceipts) || paidReceipts < 0) throw new Error("Invalid receipt count");
	return Math.min(WEEKLY_CAP, WEEKLY_BASE + PER_RECEIPT * Math.min(paidReceipts, 7)) as Credits;
}

export function reduceCredits(account: CreditAccount, move: CreditMove): CreditAccount | "INSUFFICIENT_CREDITS" {
	// TODO Grant writes EXPIRE for the unspent allowance of the previous week, then GRANT weeklyAllowance(paidReceipts).
	// TODO Spend takes exactly BID_COST, allowance first, then purchased. House bids never call Spend.
	// TODO Return copies the SPEND split for that bid back into the same buckets. No SPEND means no-op.
	//      A returned allowance credit may exceed the cap. The cap limits grants, not balance.
	// TODO Every move checks its key against lines first, so a replay returns the account unchanged.
	if (move.kind === "Purchase") throw new Error("not implemented");
	const key: CreditLine["key"] = move.kind === "Grant" ? `grant:${move.week}`
		: move.kind === "Spend" ? `spend:${move.bid}` : `return:${move.bid}`;
	if (account.lines.some(line => line.key === key)) return account;
	let allowance = account.balance.allowance;
	let purchased = account.balance.purchased;
	const lines: CreditLine[] = [...account.lines];
	if (move.kind === "Grant") {
		if (allowance > 0) lines.push({ kind: "EXPIRE", key: `expire:${move.week}`, credits: allowance, at: move.at });
		allowance = weeklyAllowance(move.paidReceipts);
		lines.push({ kind: "GRANT", key: `grant:${move.week}`, credits: allowance, at: move.at });
	} else if (move.kind === "Spend") {
		if (allowance + purchased < BID_COST) return "INSUFFICIENT_CREDITS";
		const used = Math.min(allowance, BID_COST) as Credits;
		const split = { allowance: used, purchased: (BID_COST - used) as Credits };
		allowance = (allowance - split.allowance) as Credits;
		purchased = (purchased - split.purchased) as Credits;
		lines.push({ kind: "SPEND", key: `spend:${move.bid}`, split, at: move.at });
	} else {
		const spend = account.lines.find(line => line.kind === "SPEND" && line.key === `spend:${move.bid}`);
		if (!spend || spend.kind !== "SPEND") return account;
		allowance = (allowance + spend.split.allowance) as Credits;
		purchased = (purchased + spend.split.purchased) as Credits;
		lines.push({ kind: "RETURN", key: `return:${move.bid}`, split: spend.split, reason: move.reason, at: move.at });
	}
	return { ...account, version: (account.version + 1) as Version, balance: { allowance, purchased }, lines };
}

export function creditWeek(at: Instant): WeekId {
	const date = new Date(at);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const year = date.getUTCFullYear();
	const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}` as WeekId;
}

export function nextCreditGrant(at: Instant): Instant {
	const date = new Date(at);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCDate(date.getUTCDate() + 8 - (date.getUTCDay() || 7));
	return date.toISOString() as Instant;
}
