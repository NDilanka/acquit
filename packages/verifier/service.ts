// The verifier service: the judge behind a signed, replay-proof HTTP boundary.
//
// Data shape. One registry keyed by runId holds each run's whole life as a state machine:
//   QUEUED -> RUNNING -> FINISHED
// A duplicate POST inserts nothing, so a retry can never judge twice, and the registry is the queue's
// source of truth: a bounded worker pool drains QUEUED records in arrival order, and a record that
// waited past its deadline is finished by name instead of starting late.
//
// This is the red unit: the contract and the tests exist, the boundary does not answer yet.

import type { Instant } from "../core/src/ids.ts";
import type { PublisherPort } from "../core/src/github.ts";
import type { Verdict, VerifierRunId, VerifierRunRequest } from "../core/src/verifier.ts";
import type { JudgeOutcome, JudgeSource } from "./judge.ts";
import type { SubjectLauncher } from "./subject.ts";

/** A judge source plus the one way to release it. */
export type RunSource = { readonly source: JudgeSource; readonly remove: () => void };

export type RunPhase = "QUEUED" | "RUNNING" | "FINISHED";
export type CallbackState = "NONE" | "PENDING" | "DELIVERED" | "REFUSED" | "UNDELIVERABLE";

export type RunRecord = {
	readonly request: VerifierRunRequest;
	readonly receivedAt: Instant;
	readonly acceptedAt: Instant;
	phase: RunPhase;
	startedAt: Instant | null;
	finishedAt: Instant | null;
	/** What the judge decided, or null when the run never reached it. */
	outcome: JudgeOutcome | null;
	/** A named refusal the judge does not produce: a source that never arrived, a deadline, a cache at its cap. */
	refusal: string | null;
	callback: CallbackState;
};

export type VerifierServiceDeps = {
	readonly runSecret: string;
	readonly callback: { readonly url: string; readonly secret: string };
	readonly subject: SubjectLauncher;
	readonly publisher: PublisherPort;
	/** Builds the read-only source for one run. Production fetches the commits from GitHub. */
	readonly source: (request: VerifierRunRequest) => Promise<RunSource>;
	readonly clock?: { now(): Instant };
	/** How long a run may wait for a worker before it is refused by name. */
	readonly runDeadlineMs?: number;
	readonly concurrency?: number;
	/** The subject's own deadline inside the judge. */
	readonly subjectDeadlineMs?: number;
	readonly fetch?: typeof globalThis.fetch;
	readonly log?: (line: string) => void;
};

export interface VerifierService {
	handle(request: Request): Promise<Response>;
	readonly runs: ReadonlyMap<VerifierRunId, RunRecord>;
	/** Resolves when nothing is queued or running. */
	whenIdle(): Promise<void>;
	/** Stops accepting runs, waits for the in-flight ones up to the grace, then resolves. */
	close(options?: { readonly graceMs?: number }): Promise<void>;
	readonly closing: boolean;
	readonly stats: { readonly queued: number; readonly running: number; readonly runs: number; readonly phase: "READY" | "CLOSING" };
}

/** Not built yet. Every request is refused by name so a lane sees the gap instead of a hang. */
export function createVerifierService(_deps: VerifierServiceDeps): VerifierService {
	const runs = new Map<VerifierRunId, RunRecord>();
	return {
		runs,
		closing: false,
		stats: { queued: 0, running: 0, runs: 0, phase: "READY" },
		async handle(): Promise<Response> {
			return Response.json({ error: "VERIFIER_SERVICE_NOT_IMPLEMENTED" }, { status: 501 });
		},
		async whenIdle(): Promise<void> {},
		async close(): Promise<void> {},
	};
}

export type { Verdict };
