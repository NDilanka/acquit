// The two configured ways the core talks to a verifier: a remote CI service, or the local judge for
// the unit path and development. Both authenticate the report before the core sees a verdict. A
// deployment that configures neither gets the core's fail-fast port.

import { createHmac, timingSafeEqual } from "node:crypto";
import { instant } from "../core/src/ids.ts";
import type { CommitSha, Digest, Instant, JobId, TestId } from "../core/src/ids.ts";
import { unconfiguredVerifier } from "../core/src/verifier.ts";
import type { RejectReason, TestTally, Verdict, VerifierRunId, VerifierRunRequest, VerifierPort } from "../core/src/verifier.ts";
import { runJudge } from "./judge.ts";
import type { JudgeDeps, JudgeOutcome } from "./judge.ts";

/**
 * The local judge behind the port. `start` runs the attempt and hands the verdict to `onVerdict`,
 * which is how the unit path and the development app deliver VerifierFinished without a callback route.
 */
export function createLocalVerifier(options: JudgeDeps & {
	readonly callbackSecret?: string;
	readonly onVerdict?: (request: VerifierRunRequest, verdict: Verdict) => Promise<void>;
}): VerifierPort & { readonly runs: ReadonlyMap<VerifierRunId, JudgeOutcome> } {
	const runs = new Map<VerifierRunId, JudgeOutcome>();
	const inFlight = new Map<VerifierRunId, Promise<void>>();
	return {
		runs,
		async start(request) {
			// Starting the same run twice reuses the first run.
			if (runs.has(request.runId) || inFlight.has(request.runId)) return inFlight.get(request.runId);
			const attempt = (async () => {
				const outcome = await runJudge(request, options);
				runs.set(request.runId, outcome);
				if (outcome.kind === "VERDICT" && options.onVerdict) await options.onVerdict(request, outcome.verdict);
			})();
			inFlight.set(request.runId, attempt);
			await attempt;
		},
		async parseCallback(request) {
			// Without a secret the local judge is driven in process by onVerdict, and no body is trusted.
			if (!options.callbackSecret) return null;
			const raw = await request.text();
			const header = request.headers.get("x-acquit-signature") ?? "";
			if (!signatureMatches(raw, header, options.callbackSecret)) return null;
			try { return parseCallbackBody(JSON.parse(raw) as unknown); } catch { return null; }
		},
	};
}

export type RemoteVerifierConfig = {
	readonly ciUrl: string;
	readonly callbackSecret: string;
	readonly fetch?: typeof globalThis.fetch;
};

export function createRemoteVerifier(config: RemoteVerifierConfig): VerifierPort {
	const url = config.ciUrl.trim();
	if (!url) return unconfiguredVerifier();
	const call = config.fetch ?? globalThis.fetch;
	return {
		async start(request) {
			const response = await call(new URL("/runs", url), { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify(request) });
			if (!response.ok) throw new Error(`Verifier CI refused the run with HTTP ${response.status}`);
		},
		async parseCallback(request) {
			const raw = await request.text();
			const header = request.headers.get("x-acquit-signature") ?? "";
			if (!config.callbackSecret || !signatureMatches(raw, header, config.callbackSecret)) return null;
			try {
				return parseCallbackBody(JSON.parse(raw) as unknown);
			} catch {
				return null;
			}
		},
	};
}

function signatureMatches(body: string, header: string, secret: string): boolean {
	const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : "";
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	const left = Buffer.from(provided, "utf8");
	const right = Buffer.from(expected, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Untrusted bytes become a typed report here or not at all. */
export function parseCallbackBody(value: unknown): { readonly jobId: JobId; readonly ordinal: 1 | 2 | 3; readonly verdict: Verdict } | null {
	if (!value || typeof value !== "object") return null;
	const body = value as Record<string, unknown>;
	const jobId = typeof body.jobId === "string" && /^job_[A-Za-z0-9_-]{4,80}$/.test(body.jobId) ? body.jobId as JobId : null;
	const ordinal = body.ordinal === 1 || body.ordinal === 2 || body.ordinal === 3 ? body.ordinal : null;
	const verdict = parseVerdict(body.verdict);
	return jobId && ordinal && verdict ? { jobId, ordinal, verdict } : null;
}

export function parseVerdict(value: unknown): Verdict | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const runId = nonEmptyString(raw.runId);
	const sourceCommit = nonEmptyString(raw.sourceCommit);
	const at = parseInstant(raw.at);
	if (!runId || !sourceCommit || !at) return null;
	if (raw.result === "REJECTED") {
		if (!Array.isArray(raw.reasons) || raw.reasons.length === 0) return null;
		const reasons = raw.reasons.map(parseRejectReason);
		if (reasons.some(reason => reason === null)) return null;
		return { result: "REJECTED", runId: runId as VerifierRunId, sourceCommit: sourceCommit as CommitSha,
			reasons: reasons as [RejectReason, ...RejectReason[]], at };
	}
	if (raw.result !== "VERIFIED") return null;
	const mergeCommit = nonEmptyString(raw.mergeCommit);
	const pullRequest = typeof raw.pullRequest === "number" && Number.isSafeInteger(raw.pullRequest) && raw.pullRequest > 0 ? raw.pullRequest : null;
	const frozen = parseTally(raw.frozen);
	const hidden = parseTally(raw.hidden);
	const reportDigest = typeof raw.reportDigest === "string" && /^[0-9a-f]{64}$/.test(raw.reportDigest) ? raw.reportDigest as Digest : null;
	if (!mergeCommit || !pullRequest || !frozen || !hidden || !reportDigest) return null;
	return { result: "VERIFIED", runId: runId as VerifierRunId, sourceCommit: sourceCommit as CommitSha,
		mergeCommit: mergeCommit as CommitSha, pullRequest, frozen, hidden, reportDigest, at };
}

function parseTally(value: unknown): TestTally | null {
	if (!value || typeof value !== "object") return null;
	const tally = value as Record<string, unknown>;
	const count = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
	const expected = count(tally.expected);
	const passed = count(tally.passed);
	if (expected === null || passed === null || passed > expected) return null;
	return { expected, passed };
}

function parseRejectReason(value: unknown): RejectReason | null {
	if (!value || typeof value !== "object") return null;
	const reason = value as Record<string, unknown>;
	const ids = (input: unknown): readonly TestId[] | null => Array.isArray(input) && input.every(id => typeof id === "string") ? input as unknown as readonly TestId[] : null;
	switch (reason.kind) {
		case "PROTECTED_PATH_MODIFIED": return nonEmptyString(reason.path) ? { kind: reason.kind, path: reason.path as string } : null;
		case "TEST_FRAMEWORK_IN_SOURCE": {
			const path = nonEmptyString(reason.path);
			const symbol = nonEmptyString(reason.symbol);
			return path && symbol ? { kind: reason.kind, path, symbol } : null;
		}
		case "TESTS_FAILED": case "TESTS_MISSING": {
			const suite = reason.suite === "frozen" || reason.suite === "hidden" ? reason.suite : null;
			if (!suite) return null;
			const list = ids(reason.kind === "TESTS_FAILED" ? reason.failed : reason.missing);
			if (!list) return null;
			return reason.kind === "TESTS_FAILED" ? { kind: reason.kind, suite, failed: list } : { kind: reason.kind, suite, missing: list };
		}
		case "SUBJECT_FAULT": return nonEmptyString(reason.detail) ? { kind: reason.kind, detail: reason.detail as string } : null;
		case "SUBJECT_REPLY_MALFORMED": return { kind: reason.kind };
		case "TREE_SYMLINK": return nonEmptyString(reason.path) ? { kind: reason.kind, path: reason.path as string } : null;
		case "TREE_GITLINK": return nonEmptyString(reason.path) ? { kind: reason.kind, path: reason.path as string } : null;
		case "DIFF_TOO_LARGE": {
			const paths = positiveCount(reason.paths);
			const limit = positiveCount(reason.limit);
			return paths !== null && limit !== null ? { kind: reason.kind, paths, limit } : null;
		}
		case "SOURCE_PATHS_OVER_READ_BOUND": {
			const paths = positiveCount(reason.paths);
			const limit = positiveCount(reason.limit);
			return paths !== null && limit !== null ? { kind: reason.kind, paths, limit } : null;
		}
		default: return null;
	}
}

function positiveCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function parseInstant(value: unknown): Instant | null {
	try { return typeof value === "string" ? instant(value) : null; } catch { return null; }
}
