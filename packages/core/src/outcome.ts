// The outcome seam. A vertical is one way to judge a job's work. The job core asks the registry for a
// vertical's judge: the transport that starts its runs and authenticates their reports, the wording of
// its reasons, and which reasons are caught cheats. The job core reads nothing else about a vertical.
// The code vertical is today's verifier, wrapped as it is.

import type { Branded, Instant } from "./ids.ts";
import { describeRejectReason, isTestTamper } from "./verifier.ts";
import type { RejectReason, VerifierPort } from "./verifier.ts";

/** One way to judge work. A job stores its vertical, and the registry is keyed by it. */
export type Vertical = Branded<string, "Vertical">;

export const CODE_VERTICAL = "code" as Vertical;

/** One release point of a job's price. A vertical's milestones sum to 10_000 basis points. */
export type Milestone = {
	readonly id: string;
	readonly title: string;
	readonly releaseBps: number;
};

export type PluginManifest = {
	readonly vertical: Vertical;
	readonly version: string;
	readonly title: string;
	/** True when an evidence source in this deployment is simulated. The UI labels such a job Simulated. */
	readonly simulated: boolean;
	readonly milestones: readonly Milestone[];
};

/** One milestone's outcome. NEEDS_REVIEW carries advisory flags only: it passes nothing and rejects nothing. */
export type MilestoneVerdict =
	| { readonly result: "PASSED"; readonly milestone: string; readonly at: Instant }
	| { readonly result: "REJECTED"; readonly milestone: string; readonly reasons: readonly [RejectReason, ...RejectReason[]]; readonly at: Instant }
	| { readonly result: "NEEDS_REVIEW"; readonly milestone: string; readonly flags: readonly [string, ...string[]]; readonly at: Instant };

/** The job core's view of one vertical. */
export interface OutcomeVerifierPlugin {
	readonly manifest: PluginManifest;
	/** Starts runs and authenticates their signed reports. The same port the job core has always used. */
	readonly verifier: VerifierPort;
	describeReason(reason: RejectReason): string;
	/** The analog of isTestTamper: a caught cheat, as opposed to an honest failure. */
	isFraud(reason: RejectReason): boolean;
}

export type OutcomeRegistry = Readonly<Record<Vertical, OutcomeVerifierPlugin>>;

/** The code vertical: today's verifier port, with the reason wording and the tamper check unchanged. */
export function codeVerifier(ports: { readonly verifier: VerifierPort }): OutcomeVerifierPlugin {
	return {
		manifest: { vertical: CODE_VERTICAL, version: "1.0.0", title: "Code", simulated: false,
			milestones: [{ id: "verified", title: "Verified pull request", releaseBps: 10_000 }] },
		verifier: ports.verifier,
		describeReason: describeRejectReason,
		isFraud: isTestTamper,
	};
}
