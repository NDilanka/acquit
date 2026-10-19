// The outcome registry, end to end. A job routes to the judge its vertical names. The code vertical is
// the existing verifier, wrapped as it is. A simulated second vertical runs a job to a verified verdict
// and to a rejected one. A callback finishes only a job of the vertical whose judge signed it.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeCommand, ingestVerifierCallback, verifiersOf } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { applyJobCommand, projectJob, storedVertical, TERMS, verifierRunId, wakeAt } from "../src/job.ts";
import type { Facts, JobRow } from "../src/job.ts";
import { CODE_VERTICAL, codeVerifier } from "../src/outcome.ts";
import type { OutcomeVerifierPlugin, Vertical } from "../src/outcome.ts";
import { hours, instant, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, JobId, MerchantId, OperatorId, OrderId, TestId, Version } from "../src/ids.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import type { Actor } from "../src/acquit.ts";
import { describeRejectReason, isTestTamper, unconfiguredVerifier } from "../src/verifier.ts";
import type { DefinitionOfDone, RejectReason, Verdict, VerifierPort, VerifierReport, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";

const now = instant("2026-10-06T12:00:00Z");
const STUB = "stub" as Vertical;
const merchant = "sandbox-seller" as MerchantId;
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const submittedCommit = "8f3a302b4d6ea1c1f0d24e6b0a8c5f0e1d2c3b4a" as CommitSha;

const frozenDone: DefinitionOfDone = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong" },
	frozenAt: judgedCommit, frozenTestPath: "tests/totals.test.ts", frozenTests: [], hiddenManifest: "0".repeat(64) as Digest,
	hiddenTests: [], protectedPaths: [] };

/** A job held in escrow, locked to devon-ops, and ready for its first attempt. */
function heldRow(vertical?: Vertical): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	return { id: parseJobId("job_7Q2K"), version: 1 as Version, client: "maya-client" as ClientId, tenant: null, vertical,
		title: "Totals round wrong for 3-decimal currencies", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-11-08T10:00:00Z"), definitionOfDone: frozenDone, terms: TERMS },
		bids: [{ id: "bid_submit" as never, operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: "ts-bugfixer" as AgentId, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: { bidId: "bid_submit" as never, operator: "devon-ops" as OperatorId, payee: merchant,
			agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) }, quote: quote(commercialSplit(usd("400.00")), model),
			capture, book, cutoffAt: instant("2026-10-27T12:00:00Z") }, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
}

async function openedStore(row: JobRow): Promise<SqliteStore> {
	const store = new SqliteStore(":memory:");
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		settlement: null, delivery: null, request: null });
	await store.freezeManifest(row.id, frozenDone);
	return store;
}

/** A simulated second vertical's judge. Its callbacks carry a stub marker where a signature would be. */
function stubJudge(): VerifierPort & { readonly started: VerifierRunRequest[] } {
	const started: VerifierRunRequest[] = [];
	return {
		started,
		async start(request) { started.push(request); },
		async parseCallback(request) {
			const body = await request.json() as { readonly stub?: boolean; readonly jobId: JobId; readonly ordinal: 1 | 2 | 3; readonly report: VerifierReport };
			return body.stub === true ? { jobId: body.jobId, ordinal: body.ordinal, report: body.report } : null;
		},
	};
}

function stubPlugin(judge: VerifierPort): OutcomeVerifierPlugin {
	return { manifest: { vertical: STUB, version: "0.1.0", title: "Stub print", simulated: true,
			milestones: [{ id: "print", title: "Printed part", releaseBps: 10_000 }] },
		verifier: judge, describeReason: (reason) => `Stub judge: ${describeRejectReason(reason)}`, isFraud: () => false };
}

function portsFor(store: SqliteStore, judge: VerifierPort): { readonly ports: Ports; readonly codeStarts: VerifierRunRequest[] } {
	const codeStarts: VerifierRunRequest[] = [];
	const code: VerifierPort = { async start(request) { codeStarts.push(request); }, async parseCallback() { return null; } };
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, fixtures: [], clock: { now: () => now }, verifier: code,
		verifiers: { [CODE_VERTICAL]: codeVerifier({ verifier: code }), [STUB]: stubPlugin(judge) },
		github: { merge: unimplemented }, alerts: { raise: async () => {} },
		paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented,
			verifyWebhookDelivery: unimplemented, readResource: unimplemented } };
	return { ports, codeStarts };
}

const passing = (runId: VerifierRunId): Verdict => ({ result: "VERIFIED", runId, sourceCommit: submittedCommit, mergeCommit: judgedCommit,
	pullRequest: 13, frozen: { expected: 0, passed: 0 }, hidden: { expected: 0, passed: 0 }, reportDigest: "1".repeat(64) as Digest, at: now });

const failing = (runId: VerifierRunId): Verdict => ({ result: "REJECTED", runId, sourceCommit: submittedCommit,
	reasons: [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:3" as TestId] }], reasonsTruncated: 0, tallies: null, at: now });

/** Opens a job of the given vertical, submits it, and delivers the judge's verdict. Returns the job as the store now holds it. */
async function submitAndJudge(vertical: Vertical | undefined, verdict: (runId: VerifierRunId) => Verdict) {
	const row = heldRow(vertical);
	const store = await openedStore(row);
	const judge = stubJudge();
	const { ports, codeStarts } = portsFor(store, judge);
	await executeCommand(ports, devon, parseRequestKey(randomUUID()), { type: "Submit", jobId: row.id, sourceCommit: submittedCommit });
	const response = await ingestVerifierCallback(ports, new Request("http://api.test/api/verifier/callback", { method: "POST",
		body: JSON.stringify({ stub: true, jobId: row.id, ordinal: 1, report: { kind: "VERDICT", verdict: verdict(verifierRunId(row.id, 1)) } }) }));
	const job = await store.readJob(row.id);
	assert.ok(job !== null);
	return { ports, judge, codeStarts, response, job };
}

function reviewPhase(result: ReturnType<typeof applyJobCommand>): string {
	assert.ok(typeof result !== "string");
	return result.next.state.status === "VERIFIED" ? result.next.state.review.phase : result.next.state.status;
}

test("the code vertical wraps the existing verifier, wording, and tamper check unchanged", () => {
	const port = unconfiguredVerifier();
	const code = codeVerifier({ verifier: port });
	assert.equal(code.manifest.vertical, "code");
	assert.equal(code.verifier, port);
	assert.equal(code.manifest.milestones.reduce((sum, milestone) => sum + milestone.releaseBps, 0), 10_000);
	const tamper: RejectReason = { kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" };
	assert.equal(code.describeReason(tamper), "PR modifies frozen test file tests/totals.test.ts");
	assert.equal(code.isFraud(tamper), true);
	const failed: RejectReason = { kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:3" as TestId] };
	assert.equal(code.describeReason(failed), "Hidden tests failed: hidden:3");
	assert.equal(code.isFraud(failed), false);
	assert.deepEqual(Object.keys(verifiersOf({ verifier: port })), ["code"]);
});

test("a row stored before the registry reads as the code vertical", async () => {
	const row = heldRow();
	const store = await openedStore(row);
	const stored = await store.readJob(row.id);
	assert.ok(stored !== null);
	assert.equal(storedVertical(stored), "code");
	assert.equal(storedVertical(heldRow("stub" as Vertical)), "stub");
});

test("a second vertical runs a job through the registry to a verified verdict", async () => {
	const { judge, codeStarts, response, job } = await submitAndJudge(STUB, passing);
	assert.deepEqual(judge.started.map(request => [request.ordinal, request.sourceCommit]), [[1, submittedCommit]]);
	assert.equal(codeStarts.length, 0);
	assert.deepEqual(await response.json(), { ok: true, applied: true });
	const view = projectJob(job, devon, new Map());
	assert.equal(view.vertical, "stub");
	assert.equal(view.status, "VERIFIED");
	assert.equal(view.phase, "AWAITING_CLIENT");
	assert.equal(view.pullRequest, 13);
	assert.equal(view.reviewEndsAt, instant("2026-10-09T12:00:00Z"));
	assert.deepEqual(view.attempts.history.map(attempt => [attempt.ordinal, attempt.result]), [[1, "VERIFIED"]]);
});

test("a second vertical's rejected verdict returns the job to READY with its reason", async () => {
	const { ports, response, job } = await submitAndJudge(STUB, failing);
	assert.deepEqual(await response.json(), { ok: true, applied: true });
	const view = projectJob(job, devon, new Map());
	assert.equal(view.status, "IN_PROGRESS");
	assert.equal(view.phase, "READY");
	assert.equal(view.attempts.left, 2);
	assert.equal(view.attempts.last, "REJECTED");
	assert.deepEqual(view.attempts.reasons, ["Hidden tests failed: hidden:3"]);
	const reason: RejectReason = { kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:3" as TestId] };
	assert.equal(verifiersOf(ports)[STUB].describeReason(reason), "Stub judge: Hidden tests failed: hidden:3");
});

test("a judge finishes only a job of its own vertical", async () => {
	const { codeStarts, response, job } = await submitAndJudge(undefined, passing);
	assert.equal(codeStarts.length, 1);
	assert.deepEqual(await response.json(), { ok: true, applied: false });
	const view = projectJob(job, devon, new Map());
	assert.equal(view.status, "IN_PROGRESS");
	assert.equal(view.phase, "VERIFYING");
});

test("Approve and Dispute name the judged artifact, and mergeCommit is the alias", async () => {
	const { job } = await submitAndJudge(STUB, passing);
	const facts: Facts = { actor: maya, now, loaded: { kind: "NONE" } };
	assert.equal(reviewPhase(applyJobCommand(job, { type: "Approve", jobId: job.id, artifact: judgedCommit }, facts)), "RELEASE_PENDING");
	assert.equal(reviewPhase(applyJobCommand(job, { type: "Approve", jobId: job.id, mergeCommit: judgedCommit }, facts)), "RELEASE_PENDING");
	assert.equal(applyJobCommand(job, { type: "Approve", jobId: job.id, artifact: "f".repeat(40) as CommitSha }, facts), "ARTIFACT_CHANGED");
	const disputed = { type: "Dispute" as const, jobId: job.id, artifact: judgedCommit, reason: "The export path regressed." };
	assert.equal(reviewPhase(applyJobCommand(job, disputed, facts)), "DISPUTED");
});
