// The whole loop, once, on the real fixture: Submit -> START_VERIFIER -> the judge in a child
// process -> a signed callback -> the state machine -> the projection the CLI prints. The tutorial's
// two blocks are asserted character for character from what this loop produces.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ingestVerifierCallback, executeCommand } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { applyJobCommand, TERMS, verifierRunId, wakeAt } from "../src/job.ts";
import type { JobProjection, JobRow } from "../src/job.ts";
import { hours, instant, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, CommitSha, Digest, JobId, MerchantId, OperatorId, OrderId, CaptureId, TestId, Version } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import { reduceLedger } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { quote } from "../src/paypal.ts";
import { commercialSplit } from "../src/ledger.ts";
import type { Verdict, VerifierRunRequest } from "../src/verifier.ts";
import { SqliteStore } from "../src/store.ts";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import type { Actor, CommandOutcome } from "../src/acquit.ts";
import { createFakeGitHubApp } from "../src/github.ts";
import { createLocalVerifier, createRemoteVerifier } from "../../verifier/ci.ts";
import { gitSource, hiddenManifest } from "../../verifier/judge.ts";
import { childProcessSubject } from "../../verifier/subject.ts";
import { renderSubmission } from "../../acquit-cli/src/submit.ts";

const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;

const now = instant("2026-10-06T12:00:00Z");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const tamperCommit = "fcecc9f38a9c5dbdd8b62851bc0b22dbbddf0a06" as CommitSha;
const honestCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const merchant = "sandbox-seller" as MerchantId;
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId };
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const secret = "loop-secret";

/** A job that is funded, locked to devon-ops, and ready for its first attempt. */
function heldRow(): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	return { id: parseJobId("job_7Q2K"), version: 1 as Version, client: "maya-client" as ClientId,
		title: "Totals round wrong for 3-decimal currencies", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-11-08T10:00:00Z"),
			definitionOfDone: { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
				frozenAt: frozenCommit, frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId),
				hiddenManifest: hiddenManifest().digest, hiddenTests: hiddenManifest().cases.map(c => c.id),
				protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] as never },
			terms: TERMS },
		bids: [{ id: "bid_submit" as never, operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: "ts-bugfixer" as AgentId, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: { bidId: "bid_submit" as never, operator: "devon-ops" as OperatorId, payee: merchant,
			agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) }, quote: quote(commercialSplit(usd("400.00")), model),
			capture, book, cutoffAt: instant("2026-10-27T12:00:00Z") }, attempts: { phase: "READY", history: [], runsStarted: 0 } } };
}

test("Submit on the tamper-test commit prints the tutorial's REJECTED block, then the honest fix verifies", { skip: FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false }, async () => {
	const store = new SqliteStore(":memory:");
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	let deliver!: (request: VerifierRunRequest, verdict: Verdict) => Promise<void>;
	const verifier = createLocalVerifier({ source: gitSource(FIXTURE!), subject: childProcessSubject(), publisher: createFakeGitHubApp(),
		clock: { now: () => now }, callbackSecret: secret, onVerdict: (request, verdict) => deliver(request, verdict) });
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, clock: { now: () => now }, verifier, github: { merge: unimplemented },
		alerts: { raise: async () => {} }, paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented } };
	deliver = async (request, verdict) => {
		const body = JSON.stringify({ jobId: request.jobId, ordinal: request.ordinal, verdict });
		const signature = createHmac("sha256", secret).update(body).digest("hex");
		const response = await ingestVerifierCallback(ports, new Request("http://api.test/api/verifier/callback", { method: "POST",
			headers: { "x-acquit-signature": `sha256=${signature}` }, body }));
		assert.equal(response.status, 200);
	};

	const first = await executeCommand(ports, devon, parseRequestKey(randomUUID()), { type: "Submit", jobId: row.id, sourceCommit: tamperCommit });
	const rejected = jobOf(first);
	assert.equal(verifier.runs.size, 1);
	assert.deepEqual(rejected.attempts.history.map(attempt => [attempt.ordinal, attempt.result, attempt.reasons]),
		[[1, "REJECTED", ["PR modifies frozen test file tests/totals.test.ts"]]]);
	assert.equal(rejected.attempts.left, 2);
	assert.equal(rejected.status, "IN_PROGRESS");
	assert.equal(rejected.escrow, "HELD");
	assert.equal(rejected.lockedTo, "devon-ops");
	assert.equal(renderSubmission(rejected, () => "devon-ops"), [
		"Submitted job_7Q2K (attempt 1 of 3)",
		"Verifier result: REJECTED",
		"\tPR modifies frozen test file tests/totals.test.ts",
		"Job status: IN_PROGRESS",
		"Escrow: HELD, locked to devon-ops",
		"Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.",
	].join("\n"));

	const second = await executeCommand(ports, devon, parseRequestKey(randomUUID()), { type: "Submit", jobId: row.id, sourceCommit: honestCommit });
	const verified = jobOf(second);
	assert.equal(verifier.runs.size, 2);
	assert.equal(verified.status, "VERIFIED");
	assert.equal(verified.pullRequest, 13);
	assert.equal(verified.attempts.left, 1);
	assert.equal(verified.reviewEndsAt, instant("2026-10-09T12:00:00Z"));
	assert.equal(renderSubmission(verified, () => "devon-ops"), [
		"Submitted job_7Q2K (attempt 2 of 3)",
		"Verifier result: VERIFIED",
		"\tFrozen tests: 48 passed (suite frozen at a3b6ead)",
		"\tHidden tests: 6 passed",
		"\tRequired tests: 54 completed, 0 skipped or missing",
		"\tProtected paths: none touched",
		"Pull request opened: maya-client/invoice-app#13",
		"Job status: VERIFIED",
		"Client review window: 72 hours",
	].join("\n"));
});

test("a report for a run the job is not waiting on is a no-op that burns no attempt", { skip: FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false }, async () => {
	const store = new SqliteStore(":memory:");
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	const verifier = createLocalVerifier({ source: gitSource(FIXTURE!), subject: childProcessSubject(), publisher: createFakeGitHubApp(),
		clock: { now: () => now }, callbackSecret: secret });
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, clock: { now: () => now }, verifier, github: { merge: unimplemented },
		alerts: { raise: async () => {} }, paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented } };
	const verdict: Verdict = { result: "REJECTED", runId: verifierRunId(row.id, 1), sourceCommit: tamperCommit,
		reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], at: now };
	const body = JSON.stringify({ jobId: row.id, ordinal: 1, verdict });
	const signed = () => new Request("http://api.test/api/verifier/callback", { method: "POST",
		headers: { "x-acquit-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body });
	const unsigned = new Request("http://api.test/api/verifier/callback", { method: "POST", body });

	// A report that arrives before the job submitted anything is refused, not applied.
	assert.equal((await ingestVerifierCallback(ports, unsigned)).status, 401);
	assert.equal((await ingestVerifierCallback(ports, signed())).status, 200);
	const untouched = await store.readJob(row.id);
	assert.equal(attemptsOf(untouched).history.length, 0);

	// Now the job is really waiting on run 1. The first report judges it; the redelivery changes nothing.
	const plan = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit: tamperCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	await store.commit({ job: { expectedVersion: row.version, row: plan.next, wakeAt: wakeAt(plan.next) }, operator: null, credits: [],
		outbox: [], acknowledge: null, delivery: null, request: null });
	assert.equal((await ingestVerifierCallback(ports, signed())).status, 200);
	assert.equal((await ingestVerifierCallback(ports, signed())).status, 200);
	const judged = await store.readJob(row.id);
	assert.deepEqual(attemptsOf(judged).history.map(attempt => [attempt.ordinal, attempt.verdict.result]), [[1, "REJECTED"]]);
	assert.equal(attemptsOf(judged).phase, "READY");
});

test("createAcquit routes a signed callback through its injected port and accepts none without one", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-wire-test-"));
	const verifier = { ciUrl: "https://ci.test", runSecret: secret, callbackSecret: secret };
	const paypal = { apiBase: "https://api-m.sandbox.paypal.com" as const, webOrigin: "http://localhost:5243",
		clientId: "test", secret: "test", webhookId: "", partnerMerchant: merchant, feeModel: model };
	const verdict: Verdict = { result: "REJECTED", runId: verifierRunId(parseJobId("job_7Q2K"), 1), sourceCommit: tamperCommit,
		reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], at: now };
	const signedReport = (jobId: JobId) => {
		const body = JSON.stringify({ jobId, ordinal: 1, verdict });
		return new Request("http://api.test/api/verifier/callback", { method: "POST",
			headers: { "x-acquit-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body });
	};
	try {
		const wiredUrl = join(root, "wired.db");
		const store = new SqliteStore(wiredUrl);
		const row = heldRow();
		await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [],
			outbox: [], acknowledge: null, delivery: null, request: null });
		const plan = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit: tamperCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
		if (typeof plan === "string") throw new Error(plan);
		await store.commit({ job: { expectedVersion: row.version, row: plan.next, wakeAt: wakeAt(plan.next) }, operator: null,
			credits: [], outbox: [], acknowledge: null, delivery: null, request: null });
		store.close();
		const service = createAcquit({ databaseUrl: wiredUrl, clock: { now: () => now }, paypal, verifier,
			github: { appId: "", privateKey: "", organization: "" }, verifierPort: createRemoteVerifier(verifier) });
		try {
			const applied = await service.handleVerifierCallback(signedReport(row.id));
			assert.equal(applied.status, 200);
			assert.deepEqual(await applied.json(), { ok: true, applied: true });
			const read = await service.query(devon, { type: "Job", jobId: row.id });
			if (read.kind !== "JOB") throw new Error("Expected a job result");
			assert.equal(read.job.status, "IN_PROGRESS");
			assert.equal(read.job.phase, "READY");
			assert.equal(read.job.attempts.last, "REJECTED");
			assert.deepEqual(read.job.attempts.reasons, ["PR modifies frozen test file tests/totals.test.ts"]);
			assert.equal(read.job.attempts.left, 2);
			assert.deepEqual(await (await service.handleVerifierCallback(signedReport(row.id))).json(), { ok: true, applied: false });
		} finally { closeAcquit(service); }

		const bare = createAcquit({ databaseUrl: join(root, "bare.db"), clock: { now: () => now }, paypal,
			verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
		try { assert.equal((await bare.handleVerifierCallback(signedReport(parseJobId("job_7Q2K")))).status, 401); }
		finally { closeAcquit(bare); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

function attemptsOf(row: JobRow | null) {
	assert.equal(row?.state.status, "IN_PROGRESS");
	return (row!.state as Extract<JobRow["state"], { status: "IN_PROGRESS" }>).attempts;
}

function jobOf(outcome: CommandOutcome): JobProjection {
	assert.notEqual(outcome.kind, "DENIED");
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB") throw new Error("Expected a job result");
	return outcome.result.job;
}
