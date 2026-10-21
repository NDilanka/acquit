// The code vertical's identity and manifest as pure data. The verifiers page imports this module, so it must
// not import the judge (verifier.ts) or any node module, not even for types.

import type { Branded } from "./ids.ts";

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

/** The code vertical's manifest. The verifiers page reads this same value, so the page cannot drift from the judge. */
export const CODE_MANIFEST: PluginManifest = { vertical: CODE_VERTICAL, version: "1.0.0", title: "Code", simulated: false,
	milestones: [{ id: "verified", title: "Verified pull request", releaseBps: 10_000 }] };
