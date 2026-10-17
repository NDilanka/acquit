import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { confirmFunding, executeCommand, ingestPayPalWebhook, ingestVerifierCallback, operationKey, runOutboxOnce } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, OrderId, PayoutItemId, Version } from "../src/ids.ts";
import { checkLaws, usd } from "../src/ledger.ts";
import type { LedgerLine } from "../src/ledger.ts";
import { parseWebhookEnvelope } from "../src/paypal.ts";
import type { Bps, PayPal, RemoteOutcome, ReleaseEvidence, ResourceRead } from "../src/paypal.ts";
import type { HiddenContract } from "../src/fixtures.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import type { JobRow } from "../src/job.ts";
import type { Verdict, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";

const N = 20;
const now = instant("2026-10-06T12:00:00Z");
const later = instant("2026-10-06T12:30:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const requestKey = () => parseRequestKey(randomUUID());
const deploymentContract: HiddenContract = { ids: exampleContract.ids, digest: "c0".repeat(32) as Digest };
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const payoutItemId = "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId;
const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
	disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
	sellerNet: usd("360.00"), capturedAt: now };
const releaseEvidence: ReleaseEvidence = { payoutItemId, captureId: capture.captureId, paid: usd("360.00"), at: later };
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };
const acceptance = (runId: VerifierRunId): Verdict => ({ result: "VERIFIED", runId, sourceCommit, mergeCommit, pullRequest: 13,
	frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now });
const captureBody = JSON.stringify({ id: "WH-CAPTURE-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: capture.captureId } });
const payoutBody = JSON.stringify({ id: "WH-PAYOUT-1", event_type: "PAYMENT.REFERENCED-PAYOUT-ITEM.COMPLETED",
	resource_type: "referenced_payouts_items", resource: { id: payoutItemId } });

function emptyAccount(operator = "devon-ops" as OperatorId): CreditAccount {
	return { operator, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
}
function grant(operator?: OperatorId): CreditAccount {
	const account = reduceCredits(emptyAccount(operator), { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	if (typeof account === "string") throw new Error(account);
	return account;
}
function jobOf(outcome: CommandOutcome) {
	assert.notEqual(outcome.kind, "DENIED");
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB" && outcome.result.kind !== "BID") throw new Error("Expected job result");
	return outcome.result.job;
}
function bookOf(row: JobRow | null): readonly LedgerLine[] {
	const state = row?.state;
	if (state?.status === "IN_PROGRESS" || state?.status === "VERIFIED") return state.escrow.book;
	if (state?.status === "PAID") return state.book;
	throw new Error(`No ledger on ${state?.status ?? "a missing job"}`);
}
const webhook = (ports: Ports, body: string) => ingestPayPalWebhook(ports, new Request("http://localhost:4310/paypal/webhook", { method: "POST", body }));
const verifierCallback = (ports: Ports) => ingestVerifierCallback(ports, new Request("http://api.test/api/verifier/callback", { method: "POST", body: "verdict" }));
/** The lines console.log prints while `run` settles, so a test reads each delivery's own outcome line. */
async function logOf<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
	const lines: string[] = [];
	const log = console.log;
	console.log = (...line: unknown[]) => { lines.push(line.map(String).join(" ")); };
	try { return { value: await run(), lines }; } finally { console.log = log; }
}
const outboxState = (store: SqliteStore, key: string): unknown => JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)?.state));
function alertReasons(store: SqliteStore): string[] {
	return store.db.prepare("SELECT json FROM outbox").all()
		.map(row => (JSON.parse(String(row.json)) as { effect: { kind: string; reason?: string } }).effect)
		.filter(effect => effect.kind === "ALERT").map(effect => String(effect.reason));
}

/**
 * One store, one fake PayPal, and one fake judge. The payout dispatch holds open until the test
 * releases it, so the payout webhooks and the outbox sweeps all land while a payout is in flight.
 */
function harness() {
	const store = new SqliteStore(":memory:");
	for (const [handle, kind, agentName, receipts] of [
		["devon-ops", "INDEPENDENT", "ts-bugfixer", 0], ["house-tsfix", "HOUSE", "house-ts-fixer", 41],
	] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: now } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		const credits = kind === "HOUSE" ? emptyAccount(row.id) : grant(row.id);
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), receipts);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
	let approved = false;
	const starts: VerifierRunRequest[] = [];
	const payoutRequests: string[] = [];
	let payoutSent!: () => void;
	const payoutInFlight = new Promise<void>(resolve => { payoutSent = resolve; });
	let openPayout!: () => void;
	const payoutGate = new Promise<void>(resolve => { openPayout = resolve; });
	const reads = new Map<string, ResourceRead>([
		[capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture } }],
		[payoutItemId, { kind: "SETTLED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence } }],
	]);
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const paypal: PayPal = {
		dispatch: async (call, requestId): Promise<RemoteOutcome> => {
			if (call.kind === "CREATE_ORDER") return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: capture.orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } };
			if (call.kind === "CAPTURE") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture } };
			if (call.kind !== "RELEASE") throw new Error(`Unexpected ${call.kind}`);
			payoutRequests.push(requestId);
			if (payoutRequests.length === 1) { payoutSent(); await payoutGate; }
			return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence } };
		},
		reconcile: async (): Promise<RemoteOutcome> => ({ kind: "NOT_FOUND" }),
		getOrder: async (): Promise<RemoteOutcome> => approved
			? { kind: "CONFIRMED", observation: { kind: "ORDER_APPROVED", orderId: capture.orderId } }
			: { kind: "PENDING", checkAt: now },
		parseWebhook: async raw => parseWebhookEnvelope(raw),
		verifyWebhookDelivery: async () => ({ kind: "VERIFIED" }),
		readResource: async resource => reads.get(resource.id) ?? { kind: "UNKNOWN" },
	};
	const ports: Ports = { store, feeModel: model, fixtures: [demoFixture(deploymentContract)], clock: { now: () => now },
		verifier: { start: async request => { starts.push(request); },
			parseCallback: async () => starts.length === 0 ? null : { jobId: starts[0].jobId, ordinal: 1 as const,
				report: { kind: "VERDICT", verdict: acceptance(starts[0].runId) } } },
		github: { merge: unimplemented }, alerts: { raise: async () => {} }, paypal };
	return { store, ports, starts, payoutRequests, payoutInFlight, openPayout, approve: () => { approved = true; } };
}

test("twenty identical deliveries of one verified job pay once", async () => {
	const h = harness();
	const { store, ports } = h;
	try {
		const opened = jobOf(await executeCommand(ports, maya, requestKey(), openCommand));
		const jobId = opened.id;
		const bid = await executeCommand(ports, devon, requestKey(), { type: "PlaceBid", jobId,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(ports, maya, requestKey(), { type: "AcceptBid", jobId, bidId: bid.result.bid });
		h.approve();
		assert.equal(await confirmFunding(ports, maya, jobId), true);
		const heldBook = bookOf(await store.readJob(jobId));
		assert.deepEqual(heldBook, [{ kind: "HELD", cents: 42000, at: now }]);

		// The same CaptureCompleted webhook, twenty times at once, on a job already holding its capture.
		const captures = await Promise.all(Array.from({ length: N }, () => webhook(ports, captureBody)));
		assert.deepEqual(captures.map(answer => answer.status), Array.from({ length: N }, () => 202));
		assert.deepEqual(bookOf(await store.readJob(jobId)), heldBook);

		// The same Submit of one commit, twenty times at once: one run is reserved and started.
		const submits = await Promise.all(Array.from({ length: N }, () => executeCommand(ports, devon, requestKey(), { type: "Submit", jobId, sourceCommit })));
		assert.deepEqual(submits.map(outcome => outcome.kind), Array.from({ length: N }, () => "COMMITTED"));
		assert.equal(h.starts.length, 1);
		const judging = await store.readJob(jobId);
		assert.equal(judging?.state.status === "IN_PROGRESS" && judging.state.attempts.phase, "VERIFYING");

		// The same verified verdict delivered twenty times at once: exactly one VERIFIED transition.
		const beforeVerdict = await store.readJob(jobId);
		await Promise.all(Array.from({ length: N }, () => verifierCallback(ports)));
		const verified = await store.readJob(jobId);
		assert.equal(verified?.state.status, "VERIFIED");
		assert.equal(verified?.version, (beforeVerdict?.version ?? 0) + 1);
		if (verified?.state.status !== "VERIFIED") throw new Error("Not verified");
		assert.equal(verified.state.history.length, 1);

		// The client approves. Its release dispatch is now in flight and held open.
		const releaseKey = operationKey({ kind: "RELEASE", jobId, captureId: capture.captureId, payee: merchant });
		const approving = executeCommand(ports, maya, requestKey(), { type: "Approve", jobId, mergeCommit });
		await h.payoutInFlight;
		assert.equal(h.payoutRequests.length, 1);

		// Twenty outbox sweeps of the same release row while its payout is in flight: all lease-refused.
		const sweeps = await Promise.all(Array.from({ length: N }, () => runOutboxOnce(ports, releaseKey)));
		assert.deepEqual(sweeps, Array.from({ length: N }, () => "IDLE"));
		assert.equal(h.payoutRequests.length, 1);

		// Twenty PayPal payout webhooks for the same release, at once, while the payout is still in flight.
		// One applies the release, and every other one is a no-op that names the job as the commit left it.
		const { value: payoutAnswers, lines } = await logOf(() => Promise.all(Array.from({ length: N }, () => webhook(ports, payoutBody))));
		assert.deepEqual(payoutAnswers.map(answer => answer.status), Array.from({ length: N }, () => 202));
		assert.equal((await store.readJob(jobId))?.state.status, "PAID");
		const payoutOutcomes = lines.filter(line => line.startsWith('paypal webhook "WH-PAYOUT-1" ')).map(line => line.slice('paypal webhook "WH-PAYOUT-1" '.length));
		assert.equal(payoutOutcomes.length, N);
		assert.equal(payoutOutcomes.filter(text => text === "verified, applied").length, 1);
		assert.equal(payoutOutcomes.filter(text => text === "verified, no-op, job already PAID").length, N - 1);

		h.openPayout();
		assert.equal((await approving).kind, "COMMITTED");
		assert.equal(h.payoutRequests.length, 1);

		const paid = await store.readJob(jobId);
		if (paid?.state.status !== "PAID") throw new Error(`Expected PAID, got ${paid?.state.status}`);
		const book = paid.state.book;
		assert.deepEqual(book, [{ kind: "HELD", cents: 42000, at: now }, { kind: "RELEASED", cents: 36000, at: later },
			{ kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at: later }]);
		assert.equal(checkLaws(book), "PAID");
		const sum = (kind: LedgerLine["kind"]) => book.filter(line => line.kind === kind).reduce((total, line) => total + line.cents, 0);
		const ledger = { held: sum("HELD") - sum("RELEASED") - sum("FEE") - sum("REFUND"), released: sum("RELEASED"),
			refunded: sum("REFUND"), fees: sum("FEE"), funded: sum("HELD") };
		assert.deepEqual(ledger, { held: 0, released: 36000, refunded: 0, fees: 6000, funded: 42000 });
		assert.equal(ledger.held + ledger.released + ledger.refunded + ledger.fees, ledger.funded);
		assert.equal(book.filter(line => line.kind === "RELEASED").length, 1);
		assert.equal(h.payoutRequests.length, 1);
		assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE job_id = ?").get(jobId)?.n), 1);
		assert.equal(Number(store.db.prepare("SELECT paid_receipts AS n FROM operators WHERE id = ?").get("devon-ops")?.n), 1);
		assert.equal(h.starts.length, 1);
		// The outbox's own settlement lands on the PAID row as the same payout: it is CONFIRMED, not refused.
		assert.deepEqual(outboxState(store, releaseKey), { kind: "CONFIRMED", at: "2026-10-06T12:00:00.000Z" });
		assert.deepEqual(alertReasons(store), []);
		console.log(`CONCURRENCY delivered ${N} times in parallel, paid once`);
	} finally { store.close(); }
});
