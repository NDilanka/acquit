import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { ingestVerifierCallback } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import type { Actor } from "../src/acquit.ts";
import { hours, instant, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, OrderId, Version } from "../src/ids.ts";
import { applyJobCommand, storedVertical, TERMS, verifierRunId, wakeAt } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { CODE_VERTICAL, codeVerifier } from "../src/outcome.ts";
import type { OutcomeVerifierPlugin, Vertical } from "../src/outcome.ts";
import { quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import type { DefinitionOfDone, VerifierReport } from "../src/verifier.ts";
import { createRemoteVerifier, parseCallbackBody } from "../../verifier/ci.ts";

const now = instant("2026-10-06T12:00:00Z");
const submittedCommit = "8f3a302b4d6ea1c1f0d24e6b0a8c5f0e1d2c3b4a" as CommitSha;
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const merchant = "sandbox-seller" as MerchantId;
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const callbackSecret = "shared-physical-callback-test-secret";
const laserVertical = "laser-cut" as Vertical;
const codeDone: DefinitionOfDone = { issue: { repository: "maya-client/delivery", number: 12, title: "Deliver a laser-cut panel" },
	frozenAt: judgedCommit, frozenTestPath: "tests/delivery.test.ts", frozenTests: [], hiddenManifest: "0".repeat(64) as Digest,
	hiddenTests: [], protectedPaths: [] };

/** The existing funded-job fixture, advanced through Submit so it really reserves run 1. */
function verifyingRow(vertical: Vertical = laserVertical): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	const definitionOfDone: DefinitionOfDone = vertical === laserVertical ? { ...codeDone, physical: {
		workflow: "laser-cut", deliveryPath: "delivery/panel.svg", publicSpec: {}, specDigest: "2".repeat(64) as Digest } } : codeDone;
	const held: JobRow = { id: parseJobId("job_physical_callback"), version: 1 as Version, client: "maya-client" as ClientId,
		tenant: null, vertical, title: "Deliver a laser-cut panel", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-11-08T10:00:00Z"), definitionOfDone, terms: TERMS },
		bids: [{ id: "bid_submit" as never, operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: "laser-agent" as AgentId, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: { bidId: "bid_submit" as never, operator: "devon-ops" as OperatorId,
			payee: merchant, agent: "laser-agent" as AgentId, price: usd("400.00"), eta: hours(48) },
			quote: quote(commercialSplit(usd("400.00")), model), capture, book, cutoffAt: instant("2026-10-27T12:00:00Z") },
			attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
	const plan = applyJobCommand(held, { type: "Submit", jobId: held.id, sourceCommit: submittedCommit },
		{ actor: devon, now, loaded: { kind: "NONE" } });
	assert.notEqual(typeof plan, "string");
	if (typeof plan === "string") throw new Error(plan);
	return plan.next;
}

function reportFor(row: JobRow): VerifierReport {
	return { kind: "VERDICT", verdict: { result: "VERIFIED", runId: verifierRunId(row.id, 1), sourceCommit: submittedCommit,
		mergeCommit: judgedCommit, pullRequest: 13, frozen: { expected: 0, passed: 0 }, hidden: { expected: 0, passed: 0 },
		reportDigest: "1".repeat(64) as Digest, at: now } };
}

function signed(value: unknown): Request {
	const body = JSON.stringify(value);
	return new Request("http://api.test/api/verifier/callback", { method: "POST",
		headers: { "x-acquit-signature": `sha256=${createHmac("sha256", callbackSecret).update(body).digest("hex")}` }, body });
}

async function fixture(t: TestContext, vertical: Vertical = laserVertical) {
	const row = verifyingRow(vertical);
	assert.equal(row.state.status === "IN_PROGRESS" ? row.state.attempts.phase : null, "VERIFYING");
	const store = new SqliteStore(":memory:");
	t.after(() => store.close());
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		settlement: null, delivery: null, request: null });
	assert.ok(row.contract.definitionOfDone !== null);
	await store.freezeManifest(row.id, row.contract.definitionOfDone);
	const remote = () => createRemoteVerifier({ ciUrl: "http://verifier.test", runSecret: "test-run-secret", callbackSecret });
	const code = remote();
	const laser = remote();
	const laserPlugin: OutcomeVerifierPlugin = { ...codeVerifier({ verifier: laser }),
		manifest: { vertical: laserVertical, version: "test", title: "Laser cut", simulated: true,
			milestones: [{ id: "cut", title: "Panel cut", releaseBps: 10_000 }] } };
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, fixtures: [], clock: { now: () => now }, verifier: code,
		// Code deliberately comes first; both distinct ports hold the same callback secret.
		verifiers: { [CODE_VERTICAL]: codeVerifier({ verifier: code }), [laserVertical]: laserPlugin },
		github: { merge: unimplemented }, alerts: { raise: async () => {} },
		paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented,
			verifyWebhookDelivery: unimplemented, readResource: unimplemented } };
	return { store, ports, row, body: { jobId: row.id, ordinal: 1, report: reportFor(row) } };
}

test("a signed laser-cut callback completes its stored vertical despite code authenticating first", async t => {
	const { store, ports, row, body } = await fixture(t);
	assert.equal(storedVertical((await store.readJob(row.id))!), "laser-cut");
	const response = await ingestVerifierCallback(ports, signed({ ...body, vertical: "laser-cut" }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, applied: true });
	const after = await store.readJob(row.id);
	assert.equal(after?.state.status, "VERIFIED");
	if (after?.state.status !== "VERIFIED") throw new Error("job did not leave VERIFYING");
	assert.equal(after.state.review.phase, "AWAITING_CLIENT");
	assert.deepEqual(after.state.history.map(attempt => [attempt.ordinal, attempt.verdict.result]), [[1, "VERIFIED"]]);
	const replay = await ingestVerifierCallback(ports, signed({ ...body, vertical: "laser-cut" }));
	assert.deepEqual(await replay.json(), { ok: true, applied: false });
	assert.deepEqual(await store.readJob(row.id), after);
});

test("a code-labelled callback for a laser-cut job is refused without changing its pending run", async t => {
	const { store, ports, row, body } = await fixture(t);
	const before = await store.readJob(row.id);
	const response = await ingestVerifierCallback(ports, signed({ ...body, vertical: "code" }));
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "VERTICAL_MISMATCH" });
	assert.deepEqual(await store.readJob(row.id), before);
});

test("a callback without a vertical is a no-op for a laser-cut job", async t => {
	const { store, ports, row, body } = await fixture(t);
	const before = await store.readJob(row.id);
	const response = await ingestVerifierCallback(ports, signed(body));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, applied: false });
	assert.deepEqual(await store.readJob(row.id), before);
});

test("authentication precedes even a vertical mismatch", async t => {
	const { store, ports, row, body } = await fixture(t);
	const before = await store.readJob(row.id);
	const response = await ingestVerifierCallback(ports, new Request("http://api.test/api/verifier/callback",
		{ method: "POST", body: JSON.stringify({ ...body, vertical: "code" }) }));
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
	assert.deepEqual(await store.readJob(row.id), before);
});

for (const vertical of [undefined, "code"]) {
	test(`a code job still accepts a signed ${vertical === undefined ? "legacy" : "code-labelled"} report`, async t => {
		const { store, ports, row, body } = await fixture(t, "code" as Vertical);
		const response = await ingestVerifierCallback(ports, signed({ ...body, ...(vertical === undefined ? {} : { vertical }) }));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, applied: true });
		assert.equal((await store.readJob(row.id))?.state.status, "VERIFIED");
	});
}

test("a laser-cut-labelled callback cannot finish a code job", async t => {
	const { store, ports, row, body } = await fixture(t, "code" as Vertical);
	const before = await store.readJob(row.id);
	const response = await ingestVerifierCallback(ports, signed({ ...body, vertical: "laser-cut" }));
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "VERTICAL_MISMATCH" });
	assert.deepEqual(await store.readJob(row.id), before);
});

test("an authentic callback for a missing job stays a no-op", async t => {
	const { store, ports, row, body } = await fixture(t);
	const before = await store.readJob(row.id);
	const response = await ingestVerifierCallback(ports, signed({ ...body, jobId: "job_missing", vertical: "laser-cut" }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, applied: false });
	assert.deepEqual(await store.readJob(row.id), before);
});

test("the signed parser retains a vertical and refuses malformed vertical fields", async t => {
	const { ports, body } = await fixture(t);
	assert.deepEqual(await ports.verifier.parseCallback(signed({ ...body, vertical: "laser-cut" })), { ...body, vertical: "laser-cut" });
	assert.deepEqual(parseCallbackBody(body), body);
	for (const vertical of [null, 7, "", "x".repeat(201)]) {
		assert.equal(parseCallbackBody({ ...body, vertical }), null);
	}
	assert.equal(parseCallbackBody({ ...body, vertical: "x".repeat(200) })?.vertical, "x".repeat(200));
});

for (const [kind, field] of [["DELIVERY_MISSING", "path"], ["CHECK_FAILED", "detail"]] as const) {
	test(`${kind} callbacks keep their reason with the existing 1-to-200-character text bound`, async t => {
		const { ports, row } = await fixture(t);
		const body = (value: unknown) => ({ jobId: row.id, ordinal: 1, vertical: "laser-cut", report: { kind: "VERDICT",
			verdict: { result: "REJECTED", runId: verifierRunId(row.id, 1), sourceCommit: submittedCommit, at: now,
				reasons: [{ kind, [field]: value }], reasonsTruncated: 0, tallies: null } } });
		for (const value of ["x", "x".repeat(200)]) {
			assert.deepEqual(await ports.verifier.parseCallback(signed(body(value))), body(value));
		}
		for (const value of [undefined, null, 7, "", "x".repeat(201)]) {
			assert.equal(await ports.verifier.parseCallback(signed(body(value))), null);
		}
	});
}
