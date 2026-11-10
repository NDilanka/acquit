// Operator facts: payout onboarding and agents. No money invariant lives here.
// job.ts reads an operator row at PlaceBid. Only this file writes one.

import type { AgentId, Digest, Instant, MerchantId, OperatorId, Version } from "./ids.ts";
import { CODE_VERTICAL } from "./code-manifest.ts";
import type { Vertical } from "./code-manifest.ts";

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
	/** The simulated runners belong to Acquit's own sample agents. The owner POST still accepts only claude-code or codex. */
	readonly runner: "claude-code" | "codex" | "simulated-fdm" | "simulated-laser";
	readonly promptDigest: Digest;
	readonly tools: readonly string[];
	/** Set once at creation. One of "code", "print-fdm", "laser-cut". */
	readonly task: Vertical;
	/** Null until the exam passes. Only the pass writes it. */
	readonly acquittal: Acquittal | null;
	/** Non-null only for a plugged sample. Its prompt is Acquit's own text. */
	readonly sample: string | null;
};

/** `simulated` is true only for a labelled simulated code exam. The seed and every older acquittal read it as false. */
export type Acquittal = { readonly examId: string; readonly at: Instant; readonly simulated?: boolean };

/**
 * Rows written before the exam carry none of the three new keys. An independent agent with no
 * acquittal cannot bid on a code job until it passes. No SQL migration runs.
 */
export function withAgentDefaults(raw: Omit<Agent, "task" | "acquittal" | "sample"> & Partial<Pick<Agent, "task" | "acquittal" | "sample">>): Agent {
	return { ...raw, task: raw.task ?? CODE_VERTICAL, acquittal: raw.acquittal ?? null, sample: raw.sample ?? null };
}

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
	return row.payouts.kind === "READY" && row.payouts.merchant.length > 0;
}
