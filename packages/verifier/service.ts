// The verifier service: the judge behind a signed, replay-proof HTTP boundary.
//
// Data shape. One registry keyed by runId holds each run's whole life as a state machine:
//   QUEUED -> RUNNING -> FINISHED
// A duplicate POST inserts nothing, so a retry can never judge twice, and the registry is the queue's
// source of truth: a bounded worker pool drains QUEUED records in arrival order, and a record that
// waited past its deadline is finished by name instead of starting late.
//
// Every step of a run is bounded (git fetch, subject deadline, GitHub timeouts, callback timeout), so
// a wedged dependency fails the run by name rather than holding a slot forever.

import { createHmac } from "node:crypto";
import { instant } from "../core/src/ids.ts";
import type { CommitSha, Digest, Instant, JobId, TestId } from "../core/src/ids.ts";
import type { PublisherPort } from "../core/src/github.ts";
import { boundedDetail } from "../core/src/verifier.ts";
import type { DefinitionOfDone, RunFailure, RunFailureName, Verdict, VerifierReport, VerifierRunId, VerifierRunRequest } from "../core/src/verifier.ts";
import type { JudgeOutcome, JudgeSource } from "./judge.ts";
import { runJudge } from "./judge.ts";
import type { SubjectLauncher } from "./subject.ts";
import { parseNonce, parseSignatureHeader, parseTimestamp, runSignature, signatureEquals, RUN_NONCE_HEADER, RUN_SIGNATURE_HEADER, RUN_TIMESTAMP_HEADER, RUN_TIMESTAMP_WINDOW_SECONDS } from "./signing.ts";

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

/** Replay entries expire with the timestamp window; the cap fails closed instead of evicting a live entry. */
const REPLAY_CACHE_MAX = 8_192;
const CALLBACK_ATTEMPTS = 3;
const CALLBACK_TIMEOUT_MS = 10_000;
const BODY_LIMIT_BYTES = 262_144;

export function createVerifierService(deps: VerifierServiceDeps): VerifierService {
	const clock = deps.clock ?? { now: () => instant(new Date().toISOString()) };
	const runDeadlineMs = deps.runDeadlineMs ?? 120_000;
	const concurrency = deps.concurrency ?? 2;
	const call = deps.fetch ?? globalThis.fetch;
	const log = deps.log ?? ((line: string) => console.log(line));
	const runs = new Map<VerifierRunId, RunRecord>();
	const queue: VerifierRunId[] = [];
	const seen = new Map<string, number>();
	const idleWaiters: (() => void)[] = [];
	let running = 0;
	let closing = false;

	const service: VerifierService = {
		runs,
		get closing() { return closing; },
		get stats() { return { queued: queue.length, running, runs: runs.size, phase: closing ? "CLOSING" as const : "READY" as const }; },
		handle,
		whenIdle,
		close,
	};
	return service;

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		if (url.pathname === "/healthz" && method === "GET") return json(200, { ok: true, ...service.stats });
		if (url.pathname.startsWith("/runs/") && method === "GET") {
			const record = runs.get(decodeURIComponent(url.pathname.slice("/runs/".length)) as VerifierRunId);
			return record === undefined ? json(404, { error: "RUN_NOT_FOUND" }) : json(200, runView(record));
		}
		if (url.pathname !== "/runs" || method !== "POST") return json(404, { error: "NOT_FOUND" });
		if (closing) return refuse(503, "VERIFIER_SHUTTING_DOWN");
		const raw = await request.text();
		if (Buffer.byteLength(raw) > BODY_LIMIT_BYTES) return refuse(413, "RUN_BODY_TOO_LARGE");
		const timestamp = parseTimestamp(request.headers.get(RUN_TIMESTAMP_HEADER));
		const nonce = parseNonce(request.headers.get(RUN_NONCE_HEADER));
		const signature = parseSignatureHeader(request.headers.get(RUN_SIGNATURE_HEADER));
		if (timestamp === null || nonce === null || signature === null) return refuse(401, "RUN_SIGNATURE_MISSING");
		const nowSeconds = Math.floor(Date.parse(clock.now()) / 1000);
		if (Math.abs(nowSeconds - timestamp) > RUN_TIMESTAMP_WINDOW_SECONDS) return refuse(401, "RUN_TIMESTAMP_STALE");
		if (!signatureEquals(signature, runSignature(deps.runSecret, String(timestamp), nonce, raw))) return refuse(401, "RUN_SIGNATURE_MISMATCH");
		const replayKey = `${timestamp}.${nonce}`;
		pruneReplayCache(nowSeconds);
		if (seen.has(replayKey)) return refuse(409, "RUN_REPLAYED");
		if (seen.size >= REPLAY_CACHE_MAX) return refuse(503, "RUN_REPLAY_CACHE_FULL");
		seen.set(replayKey, nowSeconds + RUN_TIMESTAMP_WINDOW_SECONDS);
		let body: unknown;
		try { body = JSON.parse(raw) as unknown; } catch { return refuse(400, "RUN_BODY_INVALID"); }
		const parsed = parseRunRequest(body);
		if (parsed === null) return refuse(400, "RUN_BODY_INVALID");
		const existing = runs.get(parsed.runId);
		if (existing) return json(202, { runId: parsed.runId, accepted: false, phase: existing.phase });
		const accepted = accept(parsed);
		log(`run ${accepted.request.runId} accepted for ${accepted.request.jobId} attempt ${accepted.request.ordinal}`);
		return json(202, { runId: accepted.request.runId, accepted: true, phase: accepted.phase });
	}

	function accept(request: VerifierRunRequest): RunRecord {
		const record: RunRecord = { request, receivedAt: clock.now(), acceptedAt: clock.now(), phase: "QUEUED",
			startedAt: null, finishedAt: null, outcome: null, refusal: null, callback: "NONE" };
		runs.set(request.runId, record);
		queue.push(request.runId);
		pump();
		return record;
	}

	function pump(): void {
		while (running < concurrency && queue.length > 0) {
			const runId = queue.shift()!;
			running++;
			void execute(runId).finally(() => {
				running--;
				if (queue.length === 0 && running === 0) for (const waiter of idleWaiters.splice(0)) waiter();
				pump();
			});
		}
		if (queue.length === 0 && running === 0) for (const waiter of idleWaiters.splice(0)) waiter();
	}

	async function execute(runId: VerifierRunId): Promise<void> {
		const record = runs.get(runId);
		if (!record || record.phase !== "QUEUED") return;
		if (Date.parse(clock.now()) - Date.parse(record.acceptedAt) > runDeadlineMs) {
			const refusal = recordRefusal(record, "RUN_DEADLINE_EXCEEDED");
			record.callback = await deliver(record.request, failureReport(record.request, "RUN_DEADLINE_EXCEEDED", ""));
			record.phase = "FINISHED";
			record.finishedAt = clock.now();
			log(`run ${runId} refused by name: RUN_DEADLINE_EXCEEDED`);
			return;
		}
		record.phase = "RUNNING";
		record.startedAt = clock.now();
		let built: RunSource | null = null;
		try {
			built = await deps.source(record.request);
			const outcome = await runJudge(record.request, { source: built.source, subject: deps.subject, publisher: deps.publisher,
				deadlineMs: deps.subjectDeadlineMs });
			// What the run view and the callback carry is bounded and redacted here, once, for every source.
			record.outcome = outcome.kind === "VERDICT" ? outcome
				: { ...outcome, failure: { ...outcome.failure, detail: boundedDetail(outcome.failure.detail) } };
			if (record.outcome.kind === "VERDICT") record.callback = await deliver(record.request, { kind: "VERDICT", verdict: record.outcome.verdict });
			else {
				// A run that ends without a verdict reports it at once, so the job returns its slot instead of
				// waiting out the run deadline for a callback that is never coming.
				record.callback = await deliver(record.request, failureReport(record.request, record.outcome.failure.name, record.outcome.failure.detail));
				log(`run ${runId} ended RUN_FAILED: ${record.outcome.failure.name}`);
			}
		} catch (error) {
			const refusal = recordRefusal(record, `SOURCE_UNAVAILABLE: ${message(error)}`);
			record.callback = await deliver(record.request, failureReport(record.request, "SOURCE_UNAVAILABLE", message(error)));
			log(`run ${runId} refused by name: ${refusal}`);
		} finally {
			try { built?.remove(); } catch { /* a tree that cannot be removed must not fail a run */ }
			record.phase = "FINISHED";
			record.finishedAt = clock.now();
		}
	}

	/** The service's half of the report contract: a named step and bounded text, never a value the run carried. */
	function failureReport(request: VerifierRunRequest, name: RunFailureName, detail: string): VerifierReport {
		const failure: RunFailure = { runId: request.runId, sourceCommit: request.sourceCommit, name, detail: boundedDetail(detail), at: clock.now() };
		return { kind: "RUN_FAILED", failure };
	}

	async function deliver(request: VerifierRunRequest, report: VerifierReport): Promise<CallbackState> {
		const body = JSON.stringify({ jobId: request.jobId, ordinal: request.ordinal, report });
		const headers = { "content-type": "application/json", "x-acquit-signature": `sha256=${callbackSignature(deps.callback.secret, body)}` };
		for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
			try {
				const response = await call(deps.callback.url, { method: "POST", headers, body, signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) });
				if (response.ok) return "DELIVERED";
				// A 4xx is this service's answer to fix, not a transport blip: retrying cannot change it.
				if (response.status < 500) return "REFUSED";
			} catch { /* network or timeout: try again */ }
		}
		return "UNDELIVERABLE";
	}

	async function whenIdle(): Promise<void> {
		if (queue.length === 0 && running === 0) return;
		await new Promise<void>(resolve => { idleWaiters.push(resolve); });
	}

	async function close(options: { readonly graceMs?: number } = {}): Promise<void> {
		closing = true;
		const grace = options.graceMs ?? 15_000;
		const deadline = Date.now() + grace;
		while ((queue.length > 0 || running > 0) && Date.now() < deadline) {
			await Promise.race([whenIdle(), new Promise(resolve => setTimeout(resolve, 100))]);
		}
		if (queue.length > 0 || running > 0) log(`shutdown left ${queue.length} queued and ${running} running`);
	}

	/** Records the named refusal and returns it, bounded and redacted, so no step's raw text escapes by value. */
	function recordRefusal(record: RunRecord, refusal: string): string {
		record.refusal = boundedDetail(refusal);
		return record.refusal;
	}

	/** A refused request is logged by name, never by value, so a lane can see why a start did not take. */
	function refuse(status: number, code: string): Response {
		log(`run request refused by name: ${code}`);
		return json(status, { error: code });
	}

	function pruneReplayCache(nowSeconds: number): void {
		for (const [key, expiresAt] of seen) if (expiresAt <= nowSeconds) seen.delete(key);
	}
}

/** The API's callback signature: an HMAC over the body alone, the scheme the core already parses. */
function callbackSignature(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

/** What a caller may see about one run: never a secret, never a tree. */
function runView(record: RunRecord): Record<string, unknown> {
	return { runId: record.request.runId, jobId: record.request.jobId, ordinal: record.request.ordinal,
		phase: record.phase, acceptedAt: record.acceptedAt, startedAt: record.startedAt, finishedAt: record.finishedAt,
		refusal: record.refusal, callback: record.callback,
		// Where the wall time went: the screen, the subject, the comparison, and the publisher, each its own step.
		timings: record.outcome === null ? null : record.outcome.timings,
		outcome: record.outcome === null ? null : record.outcome.kind === "VERDICT"
			? { kind: "VERDICT", result: record.outcome.verdict.result, reasons: record.outcome.verdict.result === "REJECTED" ? record.outcome.verdict.reasons : [],
				pullRequest: record.outcome.verdict.result === "VERIFIED" ? record.outcome.verdict.pullRequest : null }
			: { kind: "RUN_FAILED", name: record.outcome.failure.name, detail: record.outcome.failure.detail } };
}

function json(status: number, value: unknown): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Untrusted bytes become a typed run request here or not at all. */
export function parseRunRequest(value: unknown): VerifierRunRequest | null {
	if (!isRecord(value)) return null;
	const runId = idOf(value.runId, /^run_[A-Za-z0-9_-]{4,80}$/);
	const jobId = idOf(value.jobId, /^job_[A-Za-z0-9_-]{4,80}$/);
	const ordinal = value.ordinal === 1 || value.ordinal === 2 || value.ordinal === 3 ? value.ordinal : null;
	const sourceCommit = idOf(value.sourceCommit, /^[0-9a-f]{7,64}$/);
	const definitionOfDone = parseDefinitionOfDone(value.definitionOfDone);
	if (runId === null || jobId === null || ordinal === null || sourceCommit === null || definitionOfDone === null) return null;
	return { runId: runId as VerifierRunId, jobId: jobId as JobId, ordinal, sourceCommit: sourceCommit as CommitSha, definitionOfDone };
}

function parseDefinitionOfDone(value: unknown): DefinitionOfDone | null {
	if (!isRecord(value) || !isRecord(value.issue)) return null;
	const repository = typeof value.issue.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.issue.repository) ? value.issue.repository : null;
	const number = typeof value.issue.number === "number" && Number.isSafeInteger(value.issue.number) && value.issue.number > 0 ? value.issue.number : null;
	const title = boundedText(value.issue.title, 300);
	const frozenAt = idOf(value.frozenAt, /^[0-9a-f]{7,64}$/);
	const frozenTests = testIds(value.frozenTests);
	const hiddenTests = testIds(value.hiddenTests);
	const hiddenManifest = idOf(value.hiddenManifest, /^[0-9a-f]{64}$/);
	const protectedPaths = globList(value.protectedPaths);
	if (repository === null || number === null || title === null || frozenAt === null || frozenTests === null
		|| hiddenTests === null || hiddenManifest === null || protectedPaths === null) return null;
	return { issue: { repository, number, title }, frozenAt: frozenAt as CommitSha, frozenTests: frozenTests as readonly TestId[],
		hiddenManifest: hiddenManifest as Digest, hiddenTests: hiddenTests as readonly TestId[], protectedPaths: protectedPaths as unknown as DefinitionOfDone["protectedPaths"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idOf(value: unknown, pattern: RegExp): string | null {
	return typeof value === "string" && pattern.test(value) ? value : null;
}

function boundedText(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function testIds(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length > 512) return null;
	const ids = value.map(item => boundedText(item, 200));
	return ids.every((id): id is string => id !== null) ? ids : null;
}

function globList(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length > 64) return null;
	const globs = value.map(item => boundedText(item, 200));
	return globs.every((glob): glob is string => glob !== null) ? globs : null;
}
