// Operator facts: payout onboarding and agents. No money invariant lives here.
// job.ts reads an operator row at PlaceBid. Only this file writes one.

import type { AgentId, Digest, Instant, MerchantId, OperatorId, Version } from "./ids";

/**
 * Measured. Order create failed with "No permissions to set target_client_id" until the operator
 * granted permissions through a Partner Referrals action link. So payee readiness is a fact, not a flag.
 */
export type PayoutReadiness =
	| { readonly kind: "NOT_STARTED" }
	| { readonly kind: "AWAITING_CONSENT"; readonly actionUrl: string }
	| { readonly kind: "READY"; readonly merchant: MerchantId; readonly connectedAt: Instant };

/** House is an ordinary onboarded operator with its own sandbox merchant. */
export type OperatorRow = {
	readonly id: OperatorId;
	readonly version: Version;
	readonly handle: string;
	readonly kind: "INDEPENDENT" | "HOUSE";
	readonly payouts: PayoutReadiness;
};

export type ReadyOperator = OperatorRow & { readonly payouts: Extract<PayoutReadiness, { kind: "READY" }> };

/** The prompt and the model key stay on the operator's machine. Acquit stores a digest. */
export type Agent = {
	readonly id: AgentId;
	readonly owner: OperatorId;
	readonly name: string;
	readonly runner: "claude-code" | "codex";
	readonly promptDigest: Digest;
	readonly tools: readonly string[];
};

export type OperatorCommand =
	| { readonly type: "InitializeOperator"; readonly handle: string }
	| {
		readonly type: "CreateAgent";
		readonly name: string;
		readonly runner: Agent["runner"];
		readonly promptDigest: Digest;
		readonly tools: readonly string[];
	};

export type OperatorEffect = { readonly kind: "PAYPAL_ONBOARD"; readonly operator: OperatorId };

/** Produced by paypal.ts from the onboarding-completed webhook after a merchant-integration lookup. */
export type OperatorObservation = {
	readonly type: "OperatorConnected";
	readonly operator: OperatorId;
	readonly merchant: MerchantId;
	readonly at: Instant;
};

export type OperatorPlan = {
	readonly next: OperatorRow;
	readonly agent: Agent | null;
	readonly effects: readonly OperatorEffect[];
};

export function applyOperatorCommand(
	row: OperatorRow | null,
	operator: OperatorId,
	command: OperatorCommand | OperatorObservation,
	now: Instant,
): OperatorPlan | "WRONG_STATE" | "NOT_OWNER" {
	// TODO InitializeOperator creates the row and enqueues PAYPAL_ONBOARD once. A rerun returns the same action URL.
	// TODO OperatorConnected moves AWAITING_CONSENT to READY. A replay with the same merchant is a no-op.
	// TODO CreateAgent requires the caller to own the row. Agent names are unique per operator.
	throw new Error("not implemented");
}

export function readyToBid(row: OperatorRow): row is ReadyOperator {
	throw new Error("not implemented");
}
