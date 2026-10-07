import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { commercialSplit, checkLaws, formatUsd, reduceLedger, usd } from "../src/ledger.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { executeCommand, applySystemCommand, confirmFunding, ingestPayPalWebhook, ingestVerifierCallback, operationKey, runDueTimers, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, OutboxState, Ports } from "../src/effects.ts";
import { applyJobCommand, projectJob, storedDefinitionOfDone, TERMS, wakeAt } from "../src/job.ts";
import type { JobEffect, JobRow } from "../src/job.ts";
import { instant, hours, parseBidId, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, CommitSha, Digest, Instant, JobId, MerchantId, OperatorId, OrderId, CaptureId, PayoutBatchId, PayoutItemId, RefundId, Version } from "../src/ids.ts";
import type { RunFailure, RunFailureName, Verdict, VerifierReport, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { createPayPal, parseCapture, parseWebhookEnvelope, quote } from "../src/paypal.ts";
import type { Bps, PayPal, RefundEvidence, ReleaseEvidence, RemoteOutcome, ResourceRead } from "../src/paypal.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import { GitHubAppError } from "../src/github.ts";
import type { GitHubFailureCode } from "../src/github.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId };
const requestKey = () => parseRequestKey(randomUUID());
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
function fixture() {
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
	let dispatches = 0;
	let approved = false;
	let captureCalls = 0;
	let currentNow = now;
	const capture = {
		orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"),
		platformFee: usd("44.85"), sellerNet: usd("360.00"), capturedAt: now,
	};
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	/** What the route's re-read answers for one resource id. An id the test never registers is unknown to PayPal. */
	const reads = new Map<string, ResourceRead>();
	const ports: Ports = { store, feeModel: model, clientRepository: "maya-client/invoice-app", clock: { now: () => currentNow }, verifier: { start: unimplemented, parseCallback: unimplemented },
		github: { merge: unimplemented }, alerts: { raise: unimplemented }, paypal: {
			dispatch: async call => {
				dispatches++;
				if (call.kind === "CREATE_ORDER") return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: capture.orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } };
				if (call.kind === "CAPTURE") { captureCalls++; return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture } }; }
				throw new Error("Unexpected test effect");
			},
			reconcile: async () => ({ kind: "NOT_FOUND" }),
			getOrder: async () => approved ? { kind: "CONFIRMED", observation: { kind: "ORDER_APPROVED", orderId: capture.orderId } }
				: { kind: "PENDING", checkAt: now } as RemoteOutcome,
			parseWebhook: async request => parseWebhookEnvelope(await request.text()),
			readResource: async resource => reads.get(resource.id) ?? { kind: "UNKNOWN" },
		} };
	return { store, ports, capture, dispatches: () => dispatches, captureCalls: () => captureCalls,
		approve: () => { approved = true; }, advance: (at: string) => { currentNow = instant(at); },
		read: (id: string, read: ResourceRead) => { reads.set(id, read); } };
}
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };

test("commercialSplit is integer cents and quotes the measured platform fee", () => {
	const split = commercialSplit(usd("400.00"));
	assert.equal(split.held, 42000);
	assert.equal(split.fee, 6000);
	assert.equal(split.operatorNet, 36000);
	assert.equal(quote(split, model).platformFeeInstruction, 4485);
	assert.equal(formatUsd(usd("420.00")), "420.00");
	assert.throws(() => usd("1.005"));
});
test("createAcquit uses its injected Clock to expire checkout after three hours", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-clock-test-"));
	const databaseUrl = join(root, "clock.db");
	const f = fixture();
	let currentNow = now;
	const service = createAcquit({ databaseUrl, clientRepository: "maya-client/invoice-app", clock: { now: () => currentNow },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243",
			clientId: "test", secret: "test", webhookId: "", partnerMerchant: merchant, feeModel: model },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	const store = new SqliteStore(databaseUrl);
	try {
		const opened = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: opened.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		const row = await f.store.readJob(opened.id);
		assert(row);
		const plan = applyJobCommand(row, { type: "AcceptBid", jobId: row.id, bidId: bid.result.bid },
			{ actor: maya, now, loaded: { kind: "ACCEPT_BID", quote: quote(commercialSplit(usd("400.00")), model) } });
		if (typeof plan === "string") throw new Error(plan);
		const account = await f.store.readCredits("devon-ops" as OperatorId);
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		await store.commit({ job: { expectedVersion: null, row: plan.next, wakeAt: instant("2026-10-06T15:00:00Z") }, operator: null, credits: [], outbox: [], settlement: null, request: null, delivery: null });
		currentNow = instant("2026-10-06T15:00:00Z");
		await service.tick();
		const result = await service.query(maya, { type: "Job", jobId: row.id });
		assert.equal(result.kind, "JOB");
		if (result.kind !== "JOB") throw new Error("Missing job");
		assert.equal(result.job.status, "OPEN");
		assert.equal(result.job.phase, "BIDDING");
		assert.equal(result.job.bids.operators[0].status, "PENDING");
		assert.deepEqual(result.job.ledger, []);
	} finally { store.close(); closeAcquit(service); f.store.close(); await rm(root, { recursive: true, force: true }); }
});
test("sandbox card funding passes through the real order and CaptureCompleted edges", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-card-test-"));
	const databaseUrl = join(root, "card.db");
	const f = fixture();
	const store = new SqliteStore(databaseUrl);
	for (const table of ["operators", "agents", "credits"]) {
		for (const row of f.store.db.prepare(`SELECT * FROM ${table}`).all()) {
			const values = Object.values(row);
			store.db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`).run(...values);
		}
	}
	const originalFetch = globalThis.fetch;
	const originalDev = process.env.ACQUIT_DEV;
	process.env.ACQUIT_DEV = "1";
	let creates = 0;
	let reads = 0;
	const wire = { id: "CARDORDER", status: "COMPLETED", purchase_units: [{
		payee: { merchant_id: merchant }, payment_instruction: { disbursement_mode: "DELAYED" },
		payments: { captures: [{ id: "CARDCAPTURE", status: "COMPLETED", disbursement_mode: "DELAYED", create_time: now,
			amount: { currency_code: "USD", value: "420.00" }, seller_receivable_breakdown: {
				paypal_fee: { currency_code: "USD", value: "11.37" }, net_amount: { currency_code: "USD", value: "363.78" },
				platform_fees: [{ amount: { currency_code: "USD", value: "44.85" } }],
			} }] },
	}] };
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "unit-test-token", expires_in: 300 });
		if (init?.method === "POST" && url.endsWith("/v2/checkout/orders")) {
			creates++;
			const body = JSON.parse(String(init.body));
			assert.deepEqual(body.payment_source.card, { number: "4111111111111111", expiry: "2028-12", security_code: "123", name: "Acquit Sandbox Probe",
				billing_address: { address_line_1: "123 Test Street", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } });
			return Response.json(wire, { status: 201 });
		}
		assert.equal(init?.method, "GET");
		assert(url.endsWith("/v2/checkout/orders/CARDORDER"));
		reads++;
		return Response.json(wire);
	};
	const service = createAcquit({ databaseUrl, clientRepository: "maya-client/invoice-app", clock: { now: () => now }, paypal: {
		apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5253", clientId: "test", secret: "test",
		webhookId: "", partnerMerchant: merchant, feeModel: model, fundingMode: () => "card",
	}, verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	try {
		const opened = jobOf(await service.execute(maya, requestKey(), openCommand));
		const bid = await service.execute(devon, requestKey(), { type: "PlaceBid", jobId: opened.id, price: usd("400.00"),
			eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		const key = requestKey();
		const accept: UserCommand = { type: "AcceptBid", jobId: opened.id, bidId: bid.result.bid };
		const held = jobOf(await service.execute(maya, key, accept));
		assert.equal(held.status, "IN_PROGRESS");
		assert.equal(held.escrow, "HELD");
		assert.equal(held.lockedTo, "devon-ops");
		assert.deepEqual(held.ledger, [{ kind: "HELD", cents: 42000, at: now }]);
		assert.deepEqual(jobOf(await service.execute(maya, key, accept)), held);
		assert.equal(creates, 1);
		assert.equal(reads, 1);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalDev === undefined) delete process.env.ACQUIT_DEV; else process.env.ACQUIT_DEV = originalDev;
		store.close(); closeAcquit(service); f.store.close(); await rm(root, { recursive: true, force: true });
	}
});
test("PayPal checkout return and cancel URLs use the configured web origin", async () => {
	const originalFetch = globalThis.fetch;
	let source: { paypal: { experience_context: { return_url: string; cancel_url: string } } } | undefined;
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "unit-test-token", expires_in: 300 });
		source = JSON.parse(String(init?.body)).payment_source;
		return Response.json({ id: "CHECKOUTORDER", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=CHECKOUTORDER" }] });
	};
	try {
		const paypal = createPayPal({ apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5223", clientId: "test",
			secret: "test", webhookId: "", partnerMerchant: merchant, feeModel: model });
		assert.equal((await paypal.dispatch({ kind: "CREATE_ORDER", jobId: parseJobId("job_origin"), payee: merchant,
			quote: quote(commercialSplit(usd("400.00")), model) }, "request-origin")).kind, "CONFIRMED");
		assert.equal(source?.paypal.experience_context.return_url, "http://localhost:5223/paypal/return?jobId=job_origin");
		assert.equal(source?.paypal.experience_context.cancel_url, "http://localhost:5223/paypal/cancel?jobId=job_origin");
	} finally { globalThis.fetch = originalFetch; }
});
test("credits grant 30, spend 10 once, then refuse insufficient funds", () => {
	const initial = grant();
	const bid = parseBidId("bid_test");
	const spent = reduceCredits(initial, { kind: "Spend", bid, at: now });
	assert.notEqual(spent, "INSUFFICIENT_CREDITS");
	if (typeof spent === "string") throw new Error(spent);
	assert.equal(spent.balance.allowance, 20);
	assert.equal(reduceCredits(spent, { kind: "Spend", bid, at: now }), spent);
	assert.equal(reduceCredits(emptyAccount(), { kind: "Spend", bid, at: now }), "INSUFFICIENT_CREDITS");
	assert.equal(reduceCredits(initial, { kind: "Grant", week: creditWeek(now), paidReceipts: 1, at: now }), initial);
});
test("AcceptBid emits CREATE_ORDER naming the chosen payee and no ledger", () => {
	const row: JobRow = { id: parseJobId("job_test"), version: 1 as Version, client: "maya-client" as ClientId, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z"), definitionOfDone: frozenDefinition(), terms: TERMS },
		bids: [{ id: parseBidId("bid_test"), operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: "ts-bugfixer" as AgentId, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "PENDING" }],
		state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
	const plan = applyJobCommand(row, { type: "AcceptBid", jobId: row.id, bidId: row.bids[0].id },
		{ actor: maya, now, loaded: { kind: "ACCEPT_BID", quote: quote(commercialSplit(usd("400.00")), model) } });
	assert.notEqual(typeof plan, "string");
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.effects[0].kind, "CREATE_ORDER");
	assert.equal("payee" in plan.effects[0] && plan.effects[0].payee, merchant);
	assert.equal(plan.next.state.status, "OPEN");
	assert.equal(operationKey(plan.effects[0]), operationKey(plan.effects[0]));
	assert.ok(operationKey(plan.effects[0]).length <= 38);
});
test("request replay uses payload digest, prevents duplicate bids/spend, refuses changed payload", async () => {
	const f = fixture();
	try {
		const opened = await executeCommand(f.ports, maya, requestKey(), openCommand);
		const job = jobOf(opened);
		assert.equal(job.bids.house?.paidReceipts, 41);
		const key = requestKey();
		const command: UserCommand = { type: "PlaceBid", jobId: job.id, price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" };
		const first = await executeCommand(f.ports, devon, key, command);
		assert.equal(first.kind, "COMMITTED");
		const replay = await executeCommand(f.ports, devon, key, { ...command });
		assert.equal(replay.kind, "REPLAY");
		assert.deepEqual(replay.result, first.result);
		assert.deepEqual(await executeCommand(f.ports, devon, key, { ...command, pitch: "changed" }), { kind: "DENIED", reason: "KEY_REUSED_WITH_DIFFERENT_PAYLOAD" });
		assert.equal((await f.store.readCredits("devon-ops" as OperatorId)).balance.allowance, 20);
		assert.equal((await f.store.readJob(job.id))?.bids.length, 2);
	} finally { f.store.close(); }
});
test("checkout captures once, locks payee, holds 42000, and repeated capture is a no-op", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		const funding = jobOf(await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid }));
		assert.ok(funding.approveUrl);
		assert.deepEqual(funding.ledger, []);
		assert.equal(await confirmFunding(f.ports, maya, job.id), false);
		f.approve();
		assert.equal(await confirmFunding(f.ports, maya, job.id), true);
		assert.equal(await confirmFunding(f.ports, maya, job.id), true);
		assert.equal(f.captureCalls(), 1);
		const row = await f.store.readJob(job.id);
		assert.equal(row?.state.status, "IN_PROGRESS");
		if (row?.state.status !== "IN_PROGRESS") throw new Error("No held escrow");
		assert.deepEqual(row.state.escrow.book, [{ kind: "HELD", cents: 42000, at: now }]);
		assert.equal(row.state.escrow.payee.operator, "devon-ops");
		await applySystemCommand(f.ports, { type: "CaptureCompleted", jobId: job.id, capture: f.capture }, null, "new-event-id");
		assert.deepEqual(await f.store.readJob(job.id), row);
	} finally { f.store.close(); }
});
test("OpenJob and AcceptBid replay the completed inline result", async () => {
	const f = fixture();
	try {
		const openKey = requestKey();
		const opened = await executeCommand(f.ports, maya, openKey, openCommand);
		const openReplay = await executeCommand(f.ports, maya, openKey, openCommand);
		assert.equal(openReplay.kind, "REPLAY");
		assert.deepEqual(openReplay.result, opened.kind !== "DENIED" && opened.result);
		const job = jobOf(opened);
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		const key = requestKey();
		const command: UserCommand = { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid };
		const accepted = await executeCommand(f.ports, maya, key, command);
		const replay = await executeCommand(f.ports, maya, key, command);
		assert.equal(replay.kind, "REPLAY");
		assert.deepEqual(replay.result, accepted.kind !== "DENIED" && accepted.result);
		assert.equal(f.dispatches(), 1);
	} finally { f.store.close(); }
});
test("CancelJob returns spent credits and closes without a refund or capture", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		const closed = jobOf(await executeCommand(f.ports, maya, requestKey(), { type: "CancelJob", jobId: job.id }));
		assert.equal(closed.status, "CLOSED");
		assert.deepEqual(closed.ledger, []);
		assert.equal((await f.store.readCredits("devon-ops" as OperatorId)).balance.allowance, 30);
		assert.equal(f.dispatches(), 0);
	} finally { f.store.close(); }
});
test("PayPal wire parsing uses observed money and refuses immediate disbursement", () => {
	const payload = { id: "TESTORDER", purchase_units: [{ payee: { merchant_id: merchant }, payment_instruction: { disbursement_mode: "DELAYED" },
		payments: { captures: [{ id: "TESTCAPTURE", status: "COMPLETED", create_time: now, amount: { currency_code: "USD", value: "420.00" },
			seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "15.15" },
				platform_fees: [{ amount: { currency_code: "USD", value: "44.85" } }], net_amount: { currency_code: "USD", value: "360.00" } } }] } }] };
	assert.equal(parseCapture(payload).gross, 42000);
	payload.purchase_units[0].payment_instruction.disbursement_mode = "INSTANT";
	assert.throws(() => parseCapture(payload));
});
test("concurrent requests with the same key commit one bid and one spend", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const key = requestKey();
		const command: UserCommand = { type: "PlaceBid", jobId: job.id, price: usd("400.00"),
			eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" };
		const outcomes = await Promise.all([executeCommand(f.ports, devon, key, command), executeCommand(f.ports, devon, key, command)]);
		assert.deepEqual(outcomes.map(outcome => outcome.kind).sort(), ["COMMITTED", "REPLAY"]);
		assert.equal((await f.store.readCredits("devon-ops" as OperatorId)).balance.allowance, 20);
		assert.equal((await f.store.readJob(job.id))?.bids.length, 2);
	} finally { f.store.close(); }
});
test("lost capture response reconciles before redispatch and forbids cancellation", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
		const dispatch = f.ports.paypal.dispatch;
		f.ports.paypal.dispatch = async (call, id) => {
			const result = await dispatch(call, id);
			return call.kind === "CAPTURE" ? { kind: "UNKNOWN", checkAt: instant("2026-10-06T12:00:05Z") } : result;
		};
		f.ports.paypal.reconcile = async () => ({ kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		f.approve();
		assert.equal(await confirmFunding(f.ports, maya, job.id), false);
		assert.deepEqual(await executeCommand(f.ports, maya, requestKey(), { type: "CancelJob", jobId: job.id }),
			{ kind: "DENIED", reason: "PAYMENT_IN_PROGRESS" });
		f.advance("2026-10-06T12:00:06Z");
		assert.equal(await runOutboxOnce(f.ports), "WORKED");
		assert.equal((await f.store.readJob(job.id))?.state.status, "IN_PROGRESS");
		assert.equal(f.captureCalls(), 1);
	} finally { f.store.close(); }
});
test("abandoned checkout expires to bidding, then unanswered bids return credits", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
		f.advance("2026-10-06T15:00:01Z");
		await runDueTimers(f.ports);
		const row = await f.store.readJob(job.id);
		assert.equal(row?.state.status === "OPEN" && row.state.phase.kind, "BIDDING");
		assert.equal((await f.store.readCredits("devon-ops" as OperatorId)).balance.allowance, 20);
		f.advance("2026-10-09T12:00:01Z");
		await runDueTimers(f.ports);
		assert.equal((await f.store.readCredits("devon-ops" as OperatorId)).balance.allowance, 30);
		assert.ok((await f.store.readJob(job.id))?.bids.every(bid => bid.status === "RETURNED"));
		assert.equal(f.captureCalls(), 0);
	} finally { f.store.close(); }
});
test("a queued CREATE_ORDER keeps its accepted funding mode after runtime toggles", async () => {
	const f = fixture();
	let mode: "card" | "checkout" = "checkout";
	const ports = { ...f.ports, fundingMode: () => mode };
	const originalDispatch = ports.paypal.dispatch;
	const calls: string[] = [];
	let pending = true;
	ports.paypal.dispatch = async (call, id) => {
		if (call.kind === "CREATE_ORDER") {
			calls.push(call.fundingMode!);
			if (pending) return { kind: "UNKNOWN", checkAt: instant("2026-10-06T12:00:05Z") };
		}
		return originalDispatch(call, id);
	};
	try {
		const job = jobOf(await executeCommand(ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
		const stored = JSON.parse(String(f.store.db.prepare("SELECT json FROM outbox").get()!.json));
		assert.equal(stored.effect.fundingMode, "checkout");
		mode = "card"; pending = false; f.advance("2026-10-06T12:00:06Z");
		await runOutboxOnce(ports);
		assert.deepEqual(calls, ["checkout", "checkout"]);
	} finally { f.store.close(); }
});
test("PayPal pending/error deadlines and token refresh use the injected clock", async () => {
	const originalFetch = globalThis.fetch;
	let current = now;
	let oauth = 0;
	let fail = false;
	globalThis.fetch = async input => {
		if (String(input).endsWith("/v1/oauth2/token")) { oauth++; return Response.json({ access_token: "fake", expires_in: 300 }); }
		return fail ? new Response("", { status: 503 }) : Response.json({ id: "TESTORDER", status: "CREATED" });
	};
	try {
		const paypal = createPayPal({ apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5223",
			clientId: "test", secret: "test", webhookId: "", partnerMerchant: merchant, feeModel: model }, { now: () => current });
		assert.deepEqual(await paypal.getOrder("TESTORDER" as OrderId, merchant), { kind: "PENDING", checkAt: instant("2026-10-06T12:00:05.000Z") });
		current = instant("2026-10-06T16:00:00Z"); fail = true;
		assert.deepEqual(await paypal.getOrder("TESTORDER" as OrderId, merchant), { kind: "UNKNOWN", checkAt: instant("2026-10-06T16:00:05.000Z") });
		assert.equal(oauth, 2);
	} finally { globalThis.fetch = originalFetch; }
});
test("a commit settles the leased effect it was dispatched for in the same write", async () => {
	const store = new SqliteStore(":memory:");
	try {
		const key = "test-key" as OperationKey;
		store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, "{}", JSON.stringify({ kind: "LEASED", leaseUntil: now }), now);
		await store.commit({ job: null, operator: null, credits: [], outbox: [], settlement: { key,
			state: { kind: "NEEDS_HUMAN", reason: "SETTLEMENT_MISMATCH", detail: "PayPal answered RELEASE_COMPLETED for capture OTHERCAPTURE" } },
			request: null, delivery: null });
		assert.deepEqual(JSON.parse(String(store.db.prepare("SELECT state FROM outbox").get()!.state)),
			{ kind: "NEEDS_HUMAN", reason: "SETTLEMENT_MISMATCH", detail: "PayPal answered RELEASE_COMPLETED for capture OTHERCAPTURE" });
	} finally { store.close(); }
});

// The verifier path. The frozen commit and the hidden manifest are the fixture's, so the ids are literal.

const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const later = instant("2026-10-06T12:30:00Z");
const lockedPayee = { bidId: parseBidId("bid_submit"), operator: "devon-ops" as OperatorId, payee: merchant,
	agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) };
function heldRow(deliveryEndsAt = instant("2026-10-13T12:00:00Z")): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	return { id: parseJobId("job_submit"), version: 1 as Version, client: "maya-client" as ClientId, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt, definitionOfDone: frozenDefinition(), terms: TERMS },
		bids: [{ id: lockedPayee.bidId, operator: lockedPayee.operator, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: lockedPayee.agent, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: lockedPayee, quote: quote(commercialSplit(usd("400.00")), model), capture, book,
			cutoffAt: instant("2026-10-27T12:00:00Z") }, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
}
const rejection = (runId: string, source = sourceCommit): Verdict => ({ result: "REJECTED", runId: runId as VerifierRunId,
	sourceCommit: source, reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], reasonsTruncated: 0, at: now });
const acceptance = (runId: string): Verdict => ({ result: "VERIFIED", runId: runId as VerifierRunId, sourceCommit,
	mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha, pullRequest: 13,
	frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now });
const system = { actor: { role: "SYSTEM", source: "VERIFIER" } as const, now, loaded: { kind: "NONE" } as const };
const verdictReport = (verdict: Verdict): VerifierReport => ({ kind: "VERDICT", verdict });
const runFailure = (runId: string, name: RunFailureName = "PUBLISH_FAILED", detail = "no App installation on maya-client", source = sourceCommit): RunFailure =>
	({ runId: runId as VerifierRunId, sourceCommit: source, name, detail, at: now });
const failureReport = (runId: string, name?: RunFailureName, detail?: string, source?: CommitSha): VerifierReport =>
	({ kind: "RUN_FAILED", failure: runFailure(runId, name, detail, source) });

test("Submit reserves attempt 1 with a deterministic run and emits START_VERIFIER", () => {
	const row = heldRow();
	const plan = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	const attempts = (plan.next.state as Extract<typeof plan.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase, "VERIFYING");
	assert.deepEqual(attempts.phase === "VERIFYING" ? attempts.pending : null,
		{ ordinal: 1, run: 1, runId: "run_submit_1", sourceCommit, submittedAt: now, runEndsAt: later });
	assert.deepEqual(plan.effects, [{ kind: "START_VERIFIER", jobId: row.id, attempt: { ordinal: 1, run: 1, runId: "run_submit_1",
		sourceCommit, submittedAt: now, runEndsAt: later } }]);
	assert.equal(wakeAt(plan.next), later);
});

test("a second Submit of the same commit while VERIFYING is a no-op, and a different commit is refused", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const again = applyJobCommand(started.next, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof again === "string") throw new Error(again);
	assert.equal(again.next.version, started.next.version);
	assert.deepEqual(again.effects, []);
	assert.equal(applyJobCommand(started.next, { type: "Submit", jobId: row.id, sourceCommit: "f".repeat(40) as CommitSha },
		{ actor: devon, now, loaded: { kind: "NONE" } }), "VERIFIER_PENDING");
	assert.equal(applyJobCommand(heldRow(), { type: "Submit", jobId: "job_submit" as JobId, sourceCommit },
		{ actor: { role: "OPERATOR", operatorId: "other-ops" as OperatorId }, now, loaded: { kind: "NONE" } }), "NOT_OWNER");
});

test("a rejection returns the job to READY with one attempt used, and the third rejection selects the refund", () => {
	let row = heldRow();
	for (const ordinal of [1, 2] as const) {
		const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
		if (typeof started === "string") throw new Error(started);
		const runId = `run_submit_${ordinal}`;
		const finished = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection(runId)) }, system);
		if (typeof finished === "string") throw new Error(finished);
		row = finished.next;
		const attempts = (row.state as Extract<typeof row.state, { status: "IN_PROGRESS" }>).attempts;
		assert.equal(attempts.phase, "READY");
		assert.deepEqual(attempts.history.map(record => record.ordinal), Array.from({ length: ordinal }, (_, index) => index + 1));
		assert.deepEqual(attempts.history.at(-1)!.verdict, rejection(runId));
	}
	const third = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof third === "string") throw new Error(third);
	const exhausted = applyJobCommand(third.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection("run_submit_3")) }, system);
	if (typeof exhausted === "string") throw new Error(exhausted);
	const attempts = (exhausted.next.state as Extract<typeof exhausted.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase, "REFUND_PENDING");
	assert.deepEqual(attempts.phase === "REFUND_PENDING" ? attempts.refund : null, { reason: "ATTEMPTS_EXHAUSTED", selectedAt: now });
	assert.deepEqual(exhausted.effects, [{ kind: "REFUND", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant, amount: 42000 }]);
	// The refund effect settles the disposition. Until it does, the capture-age watchdog is the only clock
	// that can still change this row: it reports an unconfirmed settlement and never selects another one.
	assert.equal(wakeAt(exhausted.next), instant("2026-10-27T12:00:00Z"));
});

test("VerifierFinished ignores a run the job is not waiting for", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const stale = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection("run_submit_9")) }, system);
	if (typeof stale === "string") throw new Error(stale);
	assert.equal(stale.next.version, started.next.version);
	const replay = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id,
		report: verdictReport(rejection("run_submit_1", "f".repeat(40) as CommitSha)) }, system);
	if (typeof replay === "string") throw new Error(replay);
	assert.equal(replay.next.version, started.next.version);
});

test("a run that ends without a verdict returns the slot, records the reason, and charges no attempt", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const failed = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: failureReport("run_submit_1") }, system);
	if (typeof failed === "string") throw new Error(failed);
	assert.equal(failed.next.state.status, "IN_PROGRESS");
	const attempts = (failed.next.state as Extract<typeof failed.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase, "READY");
	assert.deepEqual(attempts.history, []);
	assert.deepEqual(attempts.failure, runFailure("run_submit_1"));
	// The projection the CLI reads: no attempt used, the reason on the attempt, no pending run.
	const view = projectJob(failed.next, devon, new Map());
	assert.equal(view.attempts.used, 0);
	assert.equal(view.attempts.left, 3);
	assert.equal(view.attempts.pending, null);
	assert.deepEqual(view.attempts.failure, runFailure("run_submit_1"));
	// The next submission is attempt 1 again, with the next run id.
	const again = applyJobCommand(failed.next, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof again === "string") throw new Error(again);
	const next = (again.next.state as Extract<typeof again.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.deepEqual(next.phase === "VERIFYING" ? next.pending : null,
		{ ordinal: 1, run: 2, runId: "run_submit_2", sourceCommit, submittedAt: now, runEndsAt: later });
});

test("a failure for a run the job is not waiting on is a no-op, and a judged attempt clears the reason", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const failed = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: failureReport("run_submit_1") }, system);
	if (typeof failed === "string") throw new Error(failed);
	for (const stale of [failureReport("run_submit_9"), failureReport("run_submit_1", "SOURCE_UNAVAILABLE", "gone", "f".repeat(40) as CommitSha)]) {
		const untouched = applyJobCommand(failed.next, { type: "VerifierFinished", jobId: row.id, report: stale }, system);
		if (typeof untouched === "string") throw new Error(untouched);
		assert.equal(untouched.next.version, failed.next.version);
	}
	const resubmitted = applyJobCommand(failed.next, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof resubmitted === "string") throw new Error(resubmitted);
	const judged = applyJobCommand(resubmitted.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection("run_submit_2")) }, system);
	if (typeof judged === "string") throw new Error(judged);
	const attempts = (judged.next.state as Extract<typeof judged.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase, "READY");
	assert.deepEqual(attempts.history.map(record => record.ordinal), [1]);
	assert.equal(attempts.failure, null);
});

test("a timed-out run gives its slot back without using an attempt, and the next run gets a fresh run id", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const timedOut = applyJobCommand(started.next, { type: "TimerDue", jobId: row.id, expectedWakeAt: later },
		{ actor: { role: "SYSTEM", source: "TIMER" }, now: later, loaded: { kind: "NONE" } });
	if (typeof timedOut === "string") throw new Error(timedOut);
	const attempts = (timedOut.next.state as Extract<typeof timedOut.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase, "READY");
	assert.deepEqual(attempts.history, []);
	// A run that never reported is a run that ended without a verdict: the slot returns, the attempt
	// count stays put, and the job names the step so the CLI prints it instead of waiting.
	assert.deepEqual(attempts.failure, { runId: "run_submit_1", sourceCommit, name: "RUN_DEADLINE_EXCEEDED", detail: "", at: later });
	assert.deepEqual(timedOut.effects, []);
	const resubmitted = applyJobCommand(timedOut.next, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now: later, loaded: { kind: "NONE" } });
	if (typeof resubmitted === "string") throw new Error(resubmitted);
	const next = (resubmitted.next.state as Extract<typeof resubmitted.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.deepEqual(next.phase === "VERIFYING" ? next.pending : null,
		{ ordinal: 1, run: 2, runId: "run_submit_2", sourceCommit, submittedAt: later, runEndsAt: instant("2026-10-06T13:00:00Z") });
});

test("a timed-out run past the delivery deadline refunds instead of returning the slot", () => {
	const row = heldRow(instant("2026-10-06T12:20:00Z"));
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	// The run's own end is the wake time; the delivery deadline alone cannot change a VERIFYING row.
	assert.equal(wakeAt(started.next), later);
	const due = applyJobCommand(started.next, { type: "TimerDue", jobId: row.id, expectedWakeAt: later },
		{ actor: { role: "SYSTEM", source: "TIMER" }, now: later, loaded: { kind: "NONE" } });
	if (typeof due === "string") throw new Error(due);
	const attempts = (due.next.state as Extract<typeof due.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.deepEqual(attempts.phase === "REFUND_PENDING" ? attempts.refund : null, { reason: "DELIVERY_DEADLINE", selectedAt: later });
	assert.deepEqual(due.effects, [{ kind: "REFUND", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant, amount: 42000 }]);
});

test("a verified run opens the client review window with the attempt history intact", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const verified = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(acceptance("run_submit_1")) }, system);
	if (typeof verified === "string") throw new Error(verified);
	assert.equal(verified.next.state.status, "VERIFIED");
	const state = verified.next.state as Extract<typeof verified.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "AWAITING_CLIENT", endsAt: instant("2026-10-09T12:00:00Z") });
	assert.equal(state.passed.ordinal, 1);
	const view = projectJob(verified.next, devon, new Map());
	assert.equal(view.pullRequest, 13);
	assert.equal(view.phase, "AWAITING_CLIENT");
	assert.deepEqual(view.attempts.history, [{ ordinal: 1, result: "VERIFIED", reasons: [], reasonsTruncated: 0, sourceCommit, at: now,
		frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, pullRequest: 13 }]);
	assert.equal(view.attempts.last, "VERIFIED");
	assert.equal(view.attempts.left, 2);
});

test("the projection carries the attempt history, the pending run, and the frozen contract", () => {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const pendingView = projectJob(started.next, devon, new Map());
	assert.equal(pendingView.attempts.used, 1);
	assert.deepEqual(pendingView.attempts.pending, { ordinal: 1, run: 1, runId: "run_submit_1", sourceCommit, submittedAt: now, runEndsAt: later });
	assert.deepEqual(pendingView.contract, { repository: "maya-client/invoice-app", frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4", frozenTests: 48,
		hiddenTests: 6, protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] });
	const rejected = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection("run_submit_1")) }, system);
	if (typeof rejected === "string") throw new Error(rejected);
	const judged = projectJob(rejected.next, devon, new Map());
	assert.equal(judged.attempts.pending, null);
	assert.equal(judged.attempts.used, 1);
	assert.equal(judged.attempts.last, "REJECTED");
	assert.deepEqual(judged.attempts.reasons, ["PR modifies frozen test file tests/totals.test.ts"]);
	assert.deepEqual(judged.attempts.history, [{ ordinal: 1, result: "REJECTED", reasons: ["PR modifies frozen test file tests/totals.test.ts"],
		reasonsTruncated: 0, sourceCommit, at: now, frozen: null, hidden: null, pullRequest: null }]);
});

test("a stored contract without a frozen definition of done parses to null and projects without one", async () => {
	const store = new SqliteStore(":memory:");
	const frozen = heldRow();
	try {
		const stored = { ...frozen, contract: { budget: frozen.contract.budget, deliveryEndsAt: frozen.contract.deliveryEndsAt, terms: TERMS } };
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(frozen.id, frozen.version, JSON.stringify(stored), later);
		const row = await store.readJob(frozen.id);
		if (!row) throw new Error("Stored job missing");
		assert.deepEqual(storedDefinitionOfDone(frozen), frozenDefinition());
		assert.equal(storedDefinitionOfDone(row), null);
		assert.equal(row.contract.definitionOfDone, null);
		const view = projectJob(row, devon, new Map());
		assert.equal(view.contract, null);
		assert.equal(view.status, "IN_PROGRESS");
		assert.equal(view.escrow, "HELD");
		assert.equal(view.lockedTo, "devon-ops");
		assert.equal(view.budget, 40000);
		assert.equal(view.deliveryEndsAt, "2026-10-13T12:00:00.000Z");
		assert.deepEqual(view.ledger, [{ kind: "HELD", cents: 42000, at: now }]);
		assert.deepEqual(view.attempts, { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null });
	} finally { store.close(); }
});

test("a failure stored before it carried a name reads back as the named shape", async () => {
	const store = new SqliteStore(":memory:");
	const frozen = heldRow();
	try {
		const stored = (failure: unknown): unknown => ({ ...frozen, state: { ...frozen.state,
			attempts: { phase: "READY", history: [], runsStarted: 1, failure } } });
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(frozen.id, frozen.version,
			JSON.stringify(stored({ runId: "run_submit_1", sourceCommit, reason: "PUBLISH_FAILED: no App installation on maya-client", at: now })), later);
		const row = await store.readJob(frozen.id);
		if (!row) throw new Error("Stored job missing");
		const attempts = (row.state as Extract<typeof row.state, { status: "IN_PROGRESS" }>).attempts;
		assert.deepEqual(attempts.phase === "READY" ? attempts.failure : null, { runId: "run_submit_1", sourceCommit,
			name: "PUBLISH_FAILED", detail: "no App installation on maya-client", at: now });
		// A legacy reason the closed set does not name keeps its text under the contract-mismatch name.
		store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(
			JSON.stringify(stored({ runId: "run_submit_1", sourceCommit, reason: "HIDDEN_MANIFEST_MISMATCH", at: now })), frozen.id);
		const read = await store.readJob(frozen.id);
		if (!read) throw new Error("Stored job missing");
		const second = (read.state as Extract<typeof read.state, { status: "IN_PROGRESS" }>).attempts;
		assert.deepEqual(second.phase === "READY" ? second.failure : null, { runId: "run_submit_1", sourceCommit,
			name: "CONTRACT_MISMATCH", detail: "HIDDEN_MANIFEST_MISMATCH", at: now });
	} finally { store.close(); }
});

test("a row stored before the freeze refuses Submit by name and pushes no work repo on capture", () => {
	const frozen = heldRow();
	const row: JobRow = { ...frozen, contract: { ...frozen.contract, definitionOfDone: null } };
	assert.equal(applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit },
		{ actor: devon, now, loaded: { kind: "NONE" } }), "CONTRACT_NOT_FROZEN");
	const open: JobRow = { ...row, state: { status: "OPEN", phase: { kind: "FUNDING", round: 1, chosen: lockedPayee,
		quote: quote(commercialSplit(usd("400.00")), model), checkoutEndsAt: instant("2026-10-06T15:00:00Z"),
		checkout: { phase: "CAPTURING", orderId: "TESTORDER" as OrderId } } } };
	const plan = applyJobCommand(open, { type: "CaptureCompleted", jobId: row.id,
		capture: (frozen.state as Extract<typeof frozen.state, { status: "IN_PROGRESS" }>).escrow.capture },
		{ actor: { role: "SYSTEM", source: "PAYPAL" }, now, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "IN_PROGRESS");
	assert.deepEqual(plan.effects, []);
});

test("capture emits CREATE_WORK_REPO with the frozen commit the contract recorded", () => {
	const row = heldRow();
	const open: JobRow = { ...row, state: { status: "OPEN", phase: { kind: "FUNDING", round: 1, chosen: lockedPayee,
		quote: quote(commercialSplit(usd("400.00")), model), checkoutEndsAt: instant("2026-10-06T15:00:00Z"),
		checkout: { phase: "CAPTURING", orderId: "TESTORDER" as OrderId } } } };
	const plan = applyJobCommand(open, { type: "CaptureCompleted", jobId: row.id,
		capture: (row.state as Extract<typeof row.state, { status: "IN_PROGRESS" }>).escrow.capture },
		{ actor: { role: "SYSTEM", source: "PAYPAL" }, now, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "IN_PROGRESS");
	assert.deepEqual(plan.effects, [{ kind: "CREATE_WORK_REPO", jobId: row.id, repository: "maya-client/invoice-app", frozenCommit: "a3b6ead29f4e367d1871e753b516cc9e832871e4" }]);
});

test("the outbox starts the run it reserved and provisions the work repo by request id", async () => {
	const store = new SqliteStore(":memory:");
	const held = heldRow();
	const reserved = applyJobCommand(held, { type: "Submit", jobId: held.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof reserved === "string") throw new Error(reserved);
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(reserved.next.id, reserved.next.version, JSON.stringify(reserved.next), later);
	const starts: VerifierRunRequest[] = [];
	const created: { jobId: string; repository: string; frozenCommit: string }[] = [];
	const base = fixture();
	const ports: Ports = { ...base.ports, store,
		workRepo: { createWorkRepo: async request => { created.push({ jobId: request.jobId, repository: request.repository, frozenCommit: request.frozenCommit });
			return { repository: "acquit-forks/invoice-app-submit", remote: "https://github.com/acquit-forks/invoice-app-submit.git", branch: "main", commit: request.frozenCommit }; } },
		verifier: { start: async request => { starts.push(request); }, parseCallback: async () => null } };
	const enqueue = (effect: JobEffect) => {
		const key = operationKey(effect);
		const state = { kind: "READY", runAt: now };
		store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, JSON.stringify({ key, effect, payloadDigest: "d", state }), JSON.stringify(state), now);
		return key;
	};
	try {
		const startKey = enqueue(reserved.effects[0]);
		assert.equal(await runOutboxOnce(ports, startKey), "WORKED");
		assert.deepEqual(starts, [{ runId: "run_submit_1", jobId: held.id, ordinal: 1, sourceCommit, definitionOfDone: frozenDefinition() }]);
		assert.equal(JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(startKey)!.state)).kind, "CONFIRMED");
		const repoKey = enqueue({ kind: "CREATE_WORK_REPO", jobId: held.id, repository: "maya-client/invoice-app", frozenCommit: "a41c9e2" as CommitSha });
		assert.equal(await runOutboxOnce(ports, repoKey), "WORKED");
		assert.deepEqual(created, [{ jobId: held.id, repository: "maya-client/invoice-app", frozenCommit: "a41c9e2" }]);
		assert.equal(JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(repoKey)!.state)).kind, "CONFIRMED");
	} finally { store.close(); base.store.close(); }
});

test("an unconfigured work repo leaves the effect waiting for a human, never hanging", async () => {	const store = new SqliteStore(":memory:");
	const row = heldRow();
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), later);
	const base = fixture();
	const ports: Ports = { ...base.ports, store };
	const effect: JobEffect = { kind: "CREATE_WORK_REPO", jobId: row.id, repository: "maya-client/invoice-app", frozenCommit: "a41c9e2" as CommitSha };
	const key = operationKey(effect);
	const state = { kind: "READY", runAt: now };
	store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, JSON.stringify({ key, effect, payloadDigest: "d", state }), JSON.stringify(state), now);
	try {
		assert.equal(await runOutboxOnce(ports, key), "WORKED");
		assert.deepEqual(JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)!.state)),
			{ kind: "NEEDS_HUMAN", reason: "GITHUB_APP_NOT_CONFIGURED" });
	} finally { store.close(); base.store.close(); }
});

// The GitHub refusal table. Every code the App client can raise lands in one disposition, and the
// transient half retries on a backoff that grows to a bound instead of a flat five seconds.

/** The disposition every code in `GitHubFailureCode` owes the outbox. */
const PERMANENT_REFUSALS: readonly GitHubFailureCode[] = ["GITHUB_APP_KEY_INVALID", "GITHUB_INSTALLATION_MISSING",
	"GITHUB_PERMISSION_MISSING", "GITHUB_FORK_MISMATCH", "GITHUB_REF_CONFLICT", "GITHUB_COMMIT_ABSENT", "GITHUB_NOT_FOUND",
	"GITHUB_RESPONSE_INVALID", "GITHUB_REQUEST_INVALID"];
const TRANSIENT_REFUSALS: readonly GitHubFailureCode[] = ["GITHUB_RATE_LIMITED", "GITHUB_TIMEOUT", "GITHUB_NETWORK"];

type EffectState = { readonly kind: string; readonly reason?: string; readonly detail?: string;
	readonly reconcileAt?: string; readonly attempt?: number };

/** One CREATE_WORK_REPO row whose work-repo port refuses with the given failure. */
function githubEffect(fail: () => never) {
	const store = new SqliteStore(":memory:");
	const row = heldRow();
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), later);
	const base = fixture();
	const effect: JobEffect = { kind: "CREATE_WORK_REPO", jobId: row.id, repository: "maya-client/invoice-app", frozenCommit: "a41c9e2" as CommitSha };
	const key = operationKey(effect);
	const state = { kind: "READY", runAt: now };
	store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, JSON.stringify({ key, effect, payloadDigest: "d", state }), JSON.stringify(state), now);
	let attempts = 0;
	let current = now;
	const ports: Ports = { ...base.ports, store, clock: { now: () => current },
		workRepo: { createWorkRepo: async () => { attempts++; return fail(); } } };
	return { store, base, ports, key, attempts: () => attempts, at: (value: Instant) => { current = value; },
		state: (): EffectState => JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)!.state)) as EffectState };
}

const githubRefusal = (code: GitHubFailureCode, status?: number) => (): never => {
	throw new GitHubAppError(code, `a server said ${code}: ${"x".repeat(900)}`, status === undefined ? {} : { status });
};

test("a permanent App refusal parks the effect for a human, with the code and the bounded detail", async () => {
	for (const code of PERMANENT_REFUSALS) {
		const f = githubEffect(githubRefusal(code));
		try {
			assert.equal(await runOutboxOnce(f.ports, f.key), "WORKED");
			const state = f.state();
			assert.equal(state.kind, "NEEDS_HUMAN", code);
			assert.equal(state.reason, code);
			assert.equal(typeof state.detail, "string", code);
			assert.ok((state.detail?.length ?? 0) <= 304, `${code} detail is ${state.detail?.length} characters`);
			// A human has to act: the same row is not dispatched again.
			f.at(instant("2026-10-06T13:00:00Z"));
			assert.equal(await runOutboxOnce(f.ports, f.key), "IDLE");
			assert.equal(f.attempts(), 1, code);
		} finally { f.store.close(); f.base.store.close(); }
	}
});

test("a transient App refusal stays uncertain with a backoff that grows to its bound", async () => {
	for (const code of TRANSIENT_REFUSALS) {
		const f = githubEffect(githubRefusal(code));
		try {
			const gaps: number[] = [];
			let at = now;
			for (let round = 0; round < 8; round++) {
				f.at(at);
				assert.equal(await runOutboxOnce(f.ports, f.key), "WORKED");
				const state = f.state();
				assert.equal(state.kind, "UNCERTAIN", `${code} at round ${round}`);
				const due = Date.parse(state.reconcileAt!);
				gaps.push(due - Date.parse(at));
				at = new Date(due).toISOString() as Instant;
			}
			assert.deepEqual(gaps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000], code);
			assert.equal(f.attempts(), 8, code);
		} finally { f.store.close(); f.base.store.close(); }
	}
});

test("an unnamed HTTP status is transient only when it is a 5xx", async () => {
	const server = githubEffect(githubRefusal("GITHUB_HTTP_ERROR", 503));
	try {
		await runOutboxOnce(server.ports, server.key);
		const state = server.state();
		assert.equal(state.kind, "UNCERTAIN");
		assert.equal(state.reconcileAt, instant("2026-10-06T12:00:05.000Z"));
	} finally { server.store.close(); server.base.store.close(); }
	const refused = githubEffect(githubRefusal("GITHUB_HTTP_ERROR", 422));
	try {
		await runOutboxOnce(refused.ports, refused.key);
		const state = refused.state();
		assert.equal(state.kind, "NEEDS_HUMAN");
		assert.equal(state.reason, "GITHUB_HTTP_ERROR");
		assert.match(state.detail ?? "", /a server said/);
	} finally { refused.store.close(); refused.base.store.close(); }
});

test("an error the App client did not name stays uncertain and retries on the backoff", async () => {
	const f = githubEffect(() => { throw new Error("not a GitHubAppError"); });
	try {
		assert.equal(await runOutboxOnce(f.ports, f.key), "WORKED");
		const state = f.state();
		assert.equal(state.kind, "UNCERTAIN");
		assert.equal(state.reconcileAt, instant("2026-10-06T12:00:05.000Z"));
	} finally { f.store.close(); f.base.store.close(); }
});

test("the verifier callback refuses a report whose ordinal is not the reserved attempt", async () => {
	const store = new SqliteStore(":memory:");
	const held = heldRow();
	const reserved = applyJobCommand(held, { type: "Submit", jobId: held.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof reserved === "string") throw new Error(reserved);
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(reserved.next.id, reserved.next.version, JSON.stringify(reserved.next), later);
	const base = fixture();
	let report: { jobId: JobId; ordinal: 1 | 2 | 3; report: VerifierReport } | null = { jobId: held.id, ordinal: 3, report: verdictReport(rejection("run_submit_1")) };
	const ports: Ports = { ...base.ports, store,
		verifier: { start: async () => {}, parseCallback: async () => report } };
	const callback = () => new Request("http://localhost:4310/api/verifier/callback", { method: "POST" });
	try {
		const refused = await ingestVerifierCallback(ports, callback());
		assert.equal(refused.status, 409);
		assert.deepEqual(await refused.json(), { error: "ORDINAL_MISMATCH" });
		const waiting = (await store.readJob(held.id))!.state as Extract<typeof held.state, { status: "IN_PROGRESS" }>;
		assert.equal(waiting.attempts.phase, "VERIFYING");
		assert.deepEqual(waiting.attempts.history, []);
		// The report that names the reserved attempt still applies.
		report = { jobId: held.id, ordinal: 1, report: verdictReport(rejection("run_submit_1")) };
		assert.equal((await ingestVerifierCallback(ports, callback())).status, 200);
		const judged = (await store.readJob(held.id))!.state as Extract<typeof held.state, { status: "IN_PROGRESS" }>;
		assert.equal(judged.attempts.phase, "READY");
		assert.equal(judged.attempts.history.length, 1);
	} finally { store.close(); base.store.close(); }
});

test("the verifier callback refuses an unauthenticated report and applies a signed one", async () => {
	const store = new SqliteStore(":memory:");
	const held = heldRow();
	const reserved = applyJobCommand(held, { type: "Submit", jobId: held.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof reserved === "string") throw new Error(reserved);
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(reserved.next.id, reserved.next.version, JSON.stringify(reserved.next), later);
	const base = fixture();
	let report: { jobId: JobId; ordinal: 1; report: VerifierReport } | null = null;
	const ports: Ports = { ...base.ports, store,
		verifier: { start: async () => {}, parseCallback: async () => report } };
	const callback = () => new Request("http://localhost:4310/api/verifier/callback", { method: "POST" });
	try {
		assert.equal((await ingestVerifierCallback(ports, callback())).status, 401);
		report = { jobId: held.id, ordinal: 1, report: verdictReport(rejection("run_submit_1")) };
		assert.equal((await ingestVerifierCallback(ports, callback())).status, 200);
		const after = await store.readJob(held.id);
		assert.equal(after?.state.status, "IN_PROGRESS");
		const attempts = (after!.state as Extract<typeof after.state, { status: "IN_PROGRESS" }>).attempts;
		assert.equal(attempts.phase, "READY");
		assert.deepEqual(attempts.history.map(record => record.verdict), [rejection("run_submit_1")]);
		// A redelivery of the same run changes nothing: the pending slot is gone, so the edge is a no-op.
		assert.equal((await ingestVerifierCallback(ports, callback())).status, 200);
		assert.deepEqual((await store.readJob(held.id))!.version, after!.version);
	} finally { store.close(); base.store.close(); }
});

// The money path: approve, release, refund, and the reimbursement of the retained refund fee.

const payoutItemId = "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId;
const payoutBatchId = "7JQW2B7WJJUCN" as PayoutBatchId;
const approvedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const cutoff = instant("2026-10-27T12:00:00Z");

function verifiedRow(): JobRow {
	const row = heldRow();
	const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
	if (typeof started === "string") throw new Error(started);
	const verified = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(acceptance("run_submit_1")) }, system);
	if (typeof verified === "string") throw new Error(verified);
	return verified.next;
}
function approvedRow(): JobRow {
	const verified = verifiedRow();
	const approved = applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: approvedCommit }, { actor: maya, now, loaded: { kind: "NONE" } });
	if (typeof approved === "string") throw new Error(approved);
	return approved.next;
}
/** Three rejected attempts select the refund, as the table's own exhaustion edge does. */
function exhaustedRow(): JobRow {
	let row = heldRow();
	for (const ordinal of [1, 2, 3] as const) {
		const started = applyJobCommand(row, { type: "Submit", jobId: row.id, sourceCommit }, { actor: devon, now, loaded: { kind: "NONE" } });
		if (typeof started === "string") throw new Error(started);
		const judged = applyJobCommand(started.next, { type: "VerifierFinished", jobId: row.id, report: verdictReport(rejection(`run_submit_${ordinal}`)) }, system);
		if (typeof judged === "string") throw new Error(judged);
		row = judged.next;
	}
	return row;
}
const releaseEvidence = (paid = usd("360.00")): ReleaseEvidence =>
	({ payoutItemId, captureId: "TESTCAPTURE" as CaptureId, paid, at: later });
const refundEvidence = (refunded = usd("420.00"), retainedProcessorFee = usd("15.15")): RefundEvidence =>
	({ refundId: "REFUND1" as RefundId, captureId: "TESTCAPTURE" as CaptureId, refunded, retainedProcessorFee, at: later });

/** The commit GitHub creates when the pull request merges, distinct from the judged tree it lands. */
const landedCommit = "d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1" as CommitSha;

/** A store-backed job with one enqueued effect, a scripted provider, and a clock the test moves. */
function moneyHarness(row: JobRow, options: { readonly paypal?: Partial<PayPal>; readonly merge?: Ports["github"]["merge"] } = {}) {
	const store = new SqliteStore(":memory:");
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
	// The timer scan loads the credits of every bidder on the row, so the harness stores one.
	const account = grant("devon-ops" as OperatorId);
	store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
	const base = fixture();
	let current = now;
	const raised: string[] = [];
	const ports: Ports = { ...base.ports, store, clock: { now: () => current },
		alerts: { raise: async effect => { raised.push(effect.reason); } },
		github: { merge: options.merge ?? (async () => ({ outcome: "MERGED", sha: landedCommit })) },
		paypal: { ...base.ports.paypal, ...options.paypal } };
	const enqueue = (effect: JobEffect) => {
		const key = operationKey(effect);
		const state = { kind: "READY", runAt: now };
		store.db.prepare("INSERT OR REPLACE INTO outbox VALUES (?, ?, ?, ?)").run(key, JSON.stringify({ key, effect, payloadDigest: "d", state }), JSON.stringify(state), now);
		return key;
	};
	return { store, base, ports, enqueue, raised, at: (value: Instant) => { current = value; },
		row: async (): Promise<JobRow> => { const read = await store.readJob(row.id); if (!read) throw new Error("Stored job missing"); return read; },
		effectState: (key: ReturnType<typeof operationKey>): { readonly kind: string; readonly reason?: string; readonly detail?: string; readonly reconcileAt?: string } =>
			JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)!.state)) as { readonly kind: string },
		effectKinds: (): readonly string[] => store.db.prepare("SELECT json FROM outbox ORDER BY rowid").all()
			.map(entry => (JSON.parse(String(entry.json)) as { effect: JobEffect }).effect.kind) };
}
const timer = { actor: { role: "SYSTEM", source: "TIMER" } as const, now, loaded: { kind: "NONE" } as const };

test("Approve names the verified artifact, emits one RELEASE, and refuses a second approval", () => {
	const verified = verifiedRow();
	assert.equal(applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: "f".repeat(40) as CommitSha },
		{ actor: maya, now, loaded: { kind: "NONE" } }), "ARTIFACT_CHANGED");
	assert.equal(applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: approvedCommit },
		{ actor: { role: "OPERATOR", operatorId: "devon-ops" as OperatorId }, now, loaded: { kind: "NONE" } }), "NOT_OWNER");
	const plan = applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: approvedCommit }, { actor: maya, now, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: now } });
	assert.deepEqual(plan.effects, [{ kind: "RELEASE", jobId: verified.id, captureId: "TESTCAPTURE", payee: merchant }]);
	// One release key per job: a second approval cannot select a second release.
	assert.equal(applyJobCommand(plan.next, { type: "Approve", jobId: verified.id, mergeCommit: approvedCommit },
		{ actor: maya, now, loaded: { kind: "NONE" } }), "REVIEW_CLOSED");
	// The review window is a hard stop: approving after it closes is refused, not applied.
	assert.equal(applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: approvedCommit },
		{ actor: maya, now: instant("2026-10-09T12:00:00Z"), loaded: { kind: "NONE" } }), "REVIEW_CLOSED");
	// The view names the artifact the client approves, so a moved head is visible before the click.
	assert.equal(projectJob(verified, maya, new Map()).mergeCommit, approvedCommit);
});

test("ReleaseSettled builds the receipt, the paid book, and the merge from the observed payout", () => {
	const approved = approvedRow();
	const plan = applyJobCommand(approved, { type: "ReleaseSettled", jobId: approved.id, release: releaseEvidence() }, system);
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "PAID");
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "PAID" }>;
	assert.deepEqual(state.book, [
		{ kind: "HELD", cents: 42000, at: now },
		{ kind: "RELEASED", cents: 36000, at: later },
		{ kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at: later },
	]);
	assert.equal(checkLaws(state.book), "PAID");
	assert.deepEqual(state.treasury, []);
	assert.deepEqual(state.merge, { phase: "PENDING" });
	assert.match(String(state.receipt.id), /^rcpt_/);
	assert.equal(state.receipt.jobId, approved.id);
	assert.equal(state.receipt.operator, "devon-ops");
	assert.equal(state.receipt.agent, "ts-bugfixer");
	assert.equal(state.receipt.pullRequest, 13);
	assert.equal(state.receipt.mergeCommit, approvedCommit);
	assert.deepEqual(state.receipt.frozen, { expected: 48, passed: 48 });
	assert.deepEqual(state.receipt.hidden, { expected: 6, passed: 6 });
	assert.equal(state.receipt.attemptsUsed, 1);
	assert.equal(state.receipt.paid, 36000);
	assert.equal(state.receipt.releasedAt, later);
	// The release evidence is kept on the row, so the payout item a lane reads back is the one observed.
	assert.deepEqual(state.release, releaseEvidence());
	assert.deepEqual(plan.effects, [{ kind: "MERGE", jobId: approved.id, pullRequest: 13, mergeCommit: approvedCommit,
		repository: "maya-client/invoice-app" }]);
	assert.equal(wakeAt(plan.next), null);
	// The receipt is the only thing that can carry the paid evidence, and it is what the API serves.
	const view = projectJob(plan.next, maya, new Map());
	assert.equal(view.status, "PAID");
	assert.equal(view.escrow, "RELEASED");
	assert.deepEqual(view.receipt, state.receipt);
	assert.deepEqual(view.release, state.release);
	assert.equal(view.release?.payoutItemId, payoutItemId);
	assert.equal(view.release?.captureId, "TESTCAPTURE");
	assert.deepEqual(view.merge, { phase: "PENDING" });
	assert.equal(view.client, "maya-client");
	assert.equal(view.viewerCanApprove, false);
	// A paid job serves the attempts its receipt used, not zero.
	assert.equal(view.attempts.used, 1);
	assert.equal(view.attempts.left, 2);
	assert.equal(view.attempts.last, "VERIFIED");
});

test("the view gates Approve on ownership and serves the attempts a settled job used", () => {
	const verified = verifiedRow();
	assert.equal(projectJob(verified, maya, new Map()).viewerCanApprove, true);
	assert.equal(projectJob(verified, { role: "CLIENT", clientId: "other-client" as ClientId }, new Map()).viewerCanApprove, false);
	assert.equal(projectJob(verified, devon, new Map()).viewerCanApprove, false);
	// The release is already selected, so there is nothing left to approve.
	assert.equal(projectJob(approvedRow(), maya, new Map()).viewerCanApprove, false);
	// A refunded job serves the attempts its history carries, and no merge or release.
	const refunded = applyJobCommand(exhaustedRow(), { type: "RefundSettled", jobId: "job_submit" as JobId, refund: refundEvidence() }, system);
	if (typeof refunded === "string") throw new Error(refunded);
	const refundedView = projectJob(refunded.next, maya, new Map());
	assert.equal(refundedView.attempts.used, 3);
	assert.equal(refundedView.attempts.left, 0);
	assert.equal(refundedView.attempts.last, "REJECTED");
	assert.equal(refundedView.merge, null);
	assert.equal(refundedView.release, null);
});

test("a release that does not name the selected disposition is never applied", () => {
	const approved = approvedRow();
	for (const wrong of [
		{ release: { ...releaseEvidence(), captureId: "OTHERCAPTURE" as CaptureId }, why: "another capture" },
		{ release: releaseEvidence(usd("359.00")), why: "a net that cannot add up to the held gross" },
	]) {
		const plan = applyJobCommand(approved, { type: "ReleaseSettled", jobId: approved.id, release: wrong.release }, system);
		if (typeof plan === "string") throw new Error(`${wrong.why}: ${plan}`);
		assert.equal(plan.next.state.status, "VERIFIED", wrong.why);
		assert.equal(plan.next.version, approved.version, wrong.why);
		assert.deepEqual(plan.effects, [{ kind: "ALERT", jobId: approved.id, reason: "SETTLEMENT_MISMATCH" }], wrong.why);
	}
	// A release observation for a job that never selected a release is a mismatch too.
	const verified = verifiedRow();
	const plan = applyJobCommand(verified, { type: "ReleaseSettled", jobId: verified.id, release: releaseEvidence() }, system);
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "VERIFIED");
	assert.deepEqual(plan.effects, [{ kind: "ALERT", jobId: verified.id, reason: "SETTLEMENT_MISMATCH" }]);
});

test("a released net below the promise is owed back to the operator and alerted", () => {
	// The capture is where the variance is observed: the card fee came in at 16.15, not the quoted 15.15,
	// so the operator nets 359.00 and the release pays exactly that. The release still adds up to the held
	// gross, which is why the ledger takes the capture's observed fee with the payout's observed net.
	const approved = approvedRow();
	const verified = approved.state as Extract<typeof approved.state, { status: "VERIFIED" }>;
	const observed = { ...verified.escrow, capture: { ...verified.escrow.capture, processorFee: usd("16.15"), sellerNet: usd("359.00") } };
	const row: JobRow = { ...approved, state: { ...verified, escrow: observed } };
	const plan = applyJobCommand(row, { type: "ReleaseSettled", jobId: row.id, release: releaseEvidence(usd("359.00")) }, system);
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "PAID");
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "PAID" }>;
	assert.deepEqual(state.book, [
		{ kind: "HELD", cents: 42000, at: now },
		{ kind: "RELEASED", cents: 35900, at: later },
		{ kind: "FEE", cents: 6100, processor: 1615, acquit: 4485, at: later },
	]);
	assert.equal(checkLaws(state.book), "PAID");
	assert.deepEqual(state.treasury, [
		{ kind: "PROCESSOR_FEE_VARIANCE", jobId: row.id, predicted: 1515, observed: 1615, at: later },
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId: row.id, operator: "devon-ops" as OperatorId, cents: 100,
			cause: "NET_BELOW_PROMISE", at: later },
	]);
	assert.deepEqual(plan.effects, [
		{ kind: "MERGE", jobId: row.id, pullRequest: 13, mergeCommit: approvedCommit, repository: "maya-client/invoice-app" },
		{ kind: "ALERT", jobId: row.id, reason: "OPERATOR_REIMBURSEMENT_OWED" },
	]);
});

test("RefundSettled refunds the held book and owes the operator the fee PayPal kept", () => {
	const exhausted = exhaustedRow();
	const plan = applyJobCommand(exhausted, { type: "RefundSettled", jobId: exhausted.id, refund: refundEvidence() }, system);
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "REFUNDED");
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "REFUNDED" }>;
	assert.deepEqual(state.book, [{ kind: "HELD", cents: 42000, at: now }, { kind: "REFUND", cents: 42000, at: later }]);
	assert.equal(checkLaws(state.book), "REFUNDED");
	assert.equal(state.reason, "ATTEMPTS_EXHAUSTED");
	assert.deepEqual(state.refund, refundEvidence());
	assert.deepEqual(state.treasury, [
		{ kind: "REFUND_FEE_RETAINED", jobId: exhausted.id, cents: 1515, at: later },
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId: exhausted.id, operator: "devon-ops" as OperatorId, cents: 1515,
			cause: "REFUND_DEBITED_OPERATOR", at: later },
	]);
	assert.deepEqual(plan.effects, [{ kind: "REIMBURSE", jobId: exhausted.id, merchant, amount: usd("15.15") }]);
	assert.equal(wakeAt(plan.next), null);
	// A refund observation for a job that is not waiting on a refund is never applied.
	const verified = verifiedRow();
	const mismatch = applyJobCommand(verified, { type: "RefundSettled", jobId: verified.id, refund: refundEvidence() }, system);
	if (typeof mismatch === "string") throw new Error(mismatch);
	assert.equal(mismatch.next.state.status, "VERIFIED");
	assert.deepEqual(mismatch.effects, [{ kind: "ALERT", jobId: verified.id, reason: "SETTLEMENT_MISMATCH" }]);
});

test("ReimbursementSettled records the payout and its 0.25 fee once", () => {
	const refunded = applyJobCommand(exhaustedRow(), { type: "RefundSettled", jobId: "job_submit" as JobId, refund: refundEvidence() }, system);
	if (typeof refunded === "string") throw new Error(refunded);
	const reimbursement = { batchId: payoutBatchId, itemId: payoutItemId, merchant, paid: usd("15.15"), fee: usd("0.25"), at: later };
	const plan = applyJobCommand(refunded.next, { type: "ReimbursementSettled", jobId: refunded.next.id, reimbursement }, system);
	if (typeof plan === "string") throw new Error(plan);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "REFUNDED" }>;
	assert.deepEqual(state.treasury.at(-1), { kind: "PAYOUT_FEE_PAID", jobId: refunded.next.id, batchId: payoutBatchId,
		paid: 1515, fee: 25, at: later });
	assert.deepEqual(plan.effects, []);
	// A redelivery of the same batch changes nothing: the row already carries its line.
	const again = applyJobCommand(plan.next, { type: "ReimbursementSettled", jobId: refunded.next.id, reimbursement }, system);
	if (typeof again === "string") throw new Error(again);
	assert.equal(again.next.version, plan.next.version);
	assert.deepEqual(again.effects, []);
});

test("the capture-age cutoff refunds work the verifier never passed", () => {
	// The delivery and review clocks normally fire first. The cutoff is the backstop for a row whose
	// clocks were missed, and it runs first in every state that holds money.
	const row = heldRow(instant("2026-11-03T12:00:00Z"));
	assert.equal(wakeAt(row), cutoff);
	const due = applyJobCommand(row, { type: "TimerDue", jobId: row.id, expectedWakeAt: cutoff },
		{ ...timer, now: cutoff });
	if (typeof due === "string") throw new Error(due);
	const attempts = (due.next.state as Extract<typeof due.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.deepEqual(attempts.phase === "REFUND_PENDING" ? attempts.refund : null, { reason: "CAPTURE_CUTOFF", selectedAt: cutoff });
	assert.deepEqual(due.effects, [{ kind: "REFUND", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant, amount: 42000 }]);
	// The cutoff handled the escrow, so the watchdog does not fire again while the refund settles.
	assert.equal(wakeAt(due.next), null);
});

test("the capture-age cutoff releases verified work, and a pending settlement only alerts", () => {
	// Work that is verified late: the review window outlives the cutoff, so the watchdog releases rather
	// than letting the escrow sit past day 21. The verifier passed, so the contract was met.
	const verified = verifiedRow();
	const state = verified.state as Extract<typeof verified.state, { status: "VERIFIED" }>;
	const held: JobRow = { ...verified, state: { ...state, review: { phase: "AWAITING_CLIENT", endsAt: instant("2026-11-01T12:00:00Z") } } };
	assert.equal(wakeAt(held), cutoff);
	const released = applyJobCommand(held, { type: "TimerDue", jobId: held.id, expectedWakeAt: cutoff }, { ...timer, now: cutoff });
	if (typeof released === "string") throw new Error(released);
	const review = (released.next.state as Extract<typeof released.next.state, { status: "VERIFIED" }>).review;
	assert.deepEqual(review.phase === "RELEASE_PENDING" ? review.release : null, { authority: "CAPTURE_CUTOFF", selectedAt: cutoff });
	assert.deepEqual(released.effects, [{ kind: "RELEASE", jobId: held.id, captureId: "TESTCAPTURE", payee: merchant }]);
	assert.equal(wakeAt(released.next), null);
	// A release that was already selected and is still unconfirmed at the cutoff: no new disposition, one alert.
	const approved = approvedRow();
	const alerted = applyJobCommand(approved, { type: "TimerDue", jobId: approved.id, expectedWakeAt: cutoff }, { ...timer, now: cutoff });
	if (typeof alerted === "string") throw new Error(alerted);
	assert.equal(alerted.next.state.status, "VERIFIED");
	const pending = (alerted.next.state as Extract<typeof alerted.next.state, { status: "VERIFIED" }>).review;
	assert.equal(pending.phase, "RELEASE_PENDING");
	assert.deepEqual(alerted.effects, [{ kind: "ALERT", jobId: approved.id, reason: "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" }]);
	assert.equal(wakeAt(alerted.next), null);
});

test("a review window that closes in silence releases the verified work", () => {
	const verified = verifiedRow();
	const endsAt = instant("2026-10-09T12:00:00Z");
	assert.equal(wakeAt(verified), endsAt);
	const due = applyJobCommand(verified, { type: "TimerDue", jobId: verified.id, expectedWakeAt: endsAt }, { ...timer, now: endsAt });
	if (typeof due === "string") throw new Error(due);
	const review = (due.next.state as Extract<typeof due.next.state, { status: "VERIFIED" }>).review;
	assert.deepEqual(review.phase === "RELEASE_PENDING" ? review.release : null, { authority: "REVIEW_SILENCE", selectedAt: endsAt });
	assert.deepEqual(due.effects, [{ kind: "RELEASE", jobId: verified.id, captureId: "TESTCAPTURE", payee: merchant }]);
});

test("a crash between the release dispatch and its settle reconciles instead of paying twice", async () => {
	const approved = approvedRow();
	let dispatches = 0;
	let reconciles = 0;
	const harness = moneyHarness(approved, { paypal: {
		dispatch: async call => { if (call.kind !== "RELEASE") throw new Error(`Unexpected ${call.kind}`);
			dispatches++; return { kind: "UNKNOWN", checkAt: instant("2026-10-06T12:00:05.000Z") }; },
		reconcile: async call => { if (call.kind !== "RELEASE") throw new Error(`Unexpected ${call.kind}`);
			reconciles++; return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence() } }; },
	} });
	try {
		const key = harness.enqueue({ kind: "RELEASE", jobId: approved.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		assert.deepEqual(harness.effectState(key), { kind: "UNCERTAIN", reconcileAt: instant("2026-10-06T12:00:05.000Z") });
		assert.equal((await harness.row()).state.status, "VERIFIED");
		harness.at(instant("2026-10-06T12:00:05.000Z"));
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		assert.equal((await harness.row()).state.status, "PAID");
		assert.equal(dispatches, 1);
		assert.equal(reconciles, 1);
		assert.deepEqual(harness.effectKinds(), ["RELEASE", "MERGE"]);
		assert.equal(harness.effectState(key).kind, "CONFIRMED");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("an uncertain release never becomes a refund, even at the capture-age cutoff", async () => {
	const approved = approvedRow();
	const harness = moneyHarness(approved, { paypal: {
		dispatch: async () => ({ kind: "UNKNOWN", checkAt: instant("2026-10-06T12:00:05.000Z") }),
		reconcile: async () => ({ kind: "UNKNOWN", checkAt: instant("2026-10-06T12:00:05.000Z") }),
	} });
	try {
		const releaseKey = harness.enqueue({ kind: "RELEASE", jobId: approved.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
		assert.equal(await runOutboxOnce(harness.ports, releaseKey), "WORKED");
		// The provider still cannot say whether the payout landed when the cutoff arrives.
		harness.at(cutoff);
		await runDueTimers(harness.ports);
		const row = await harness.row();
		assert.equal(row.state.status, "VERIFIED");
		const review = (row.state as Extract<typeof row.state, { status: "VERIFIED" }>).review;
		assert.equal(review.phase, "RELEASE_PENDING");
		assert.deepEqual(harness.effectKinds(), ["RELEASE", "ALERT"]);
		assert.equal(wakeAt(row), null);
		const alertKey = operationKey({ kind: "ALERT", jobId: approved.id, reason: "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" });
		assert.equal(await runOutboxOnce(harness.ports, alertKey), "WORKED");
		assert.deepEqual(harness.raised, ["SETTLEMENT_UNCONFIRMED_AT_CUTOFF"]);
		// The row keeps reconciling: the release row is still due, and no refund was ever selected.
		assert.deepEqual(harness.effectKinds(), ["RELEASE", "ALERT"]);
		assert.equal(harness.effectState(releaseKey).kind, "UNCERTAIN");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("a release the provider says already paid parks for a person and is never refunded", async () => {
	const approved = approvedRow();
	const harness = moneyHarness(approved, { paypal: {
		dispatch: async () => ({ kind: "PERMANENT_FAILURE", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" }),
		reconcile: async () => ({ kind: "PERMANENT_FAILURE", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" }),
	} });
	try {
		const key = harness.enqueue({ kind: "RELEASE", jobId: approved.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		assert.deepEqual(harness.effectState(key), { kind: "NEEDS_HUMAN", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" });
		assert.equal((await harness.row()).state.status, "VERIFIED");
		assert.deepEqual(harness.effectKinds(), ["RELEASE"]);
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("a settlement the row refuses is parked for a person and never acknowledged", async () => {
	// The provider says the release paid, but its evidence names another capture. The row's selected
	// disposition is the guard, so the job must not move — and the outbox must not ack a money move the
	// row refused. The provider's own answer is what the parked row carries.
	const approved = approvedRow();
	const harness = moneyHarness(approved, { paypal: {
		dispatch: async () => ({ kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED",
			release: { ...releaseEvidence(), captureId: "OTHERCAPTURE" as CaptureId } } }),
		reconcile: async () => ({ kind: "NOT_FOUND" }),
	} });
	try {
		const key = harness.enqueue({ kind: "RELEASE", jobId: approved.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		assert.equal((await harness.row()).state.status, "VERIFIED");
		assert.equal(harness.effectState(key).kind, "NEEDS_HUMAN");
		assert.equal(harness.effectState(key).reason, "SETTLEMENT_MISMATCH");
		assert.match(String(harness.effectState(key).detail), /RELEASE_COMPLETED for capture OTHERCAPTURE/);
		// The mismatch is a fact a person sees: the row's own alert is enqueued next to the parked effect.
		assert.deepEqual(harness.effectKinds(), ["RELEASE", "ALERT"]);
		// A parked row is never leased again, so no later sweep re-POSTs the payout.
		assert.equal(await runOutboxOnce(harness.ports, key), "IDLE");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("a refusal parks the effect in the commit itself, so a crash cannot leave it acknowledged", async () => {
	// Settling a refusal used to take two writes: the commit acknowledged the money move CONFIRMED and a
	// second write parked it. A crash between them left the row acknowledged with the job unmoved. The
	// commit that refuses the observation is the only write now, so a store that dies on any other write
	// still leaves the row parked, carrying the provider's answer.
	const approved = approvedRow();
	const harness = moneyHarness(approved, { paypal: {
		dispatch: async () => ({ kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED",
			release: { ...releaseEvidence(), captureId: "OTHERCAPTURE" as CaptureId } } }),
		reconcile: async () => ({ kind: "NOT_FOUND" }),
	} });
	try {
		const writes: OutboxState[] = [];
		harness.store.recordEffect = async (_key, state) => {
			writes.push(state);
			throw new Error("the process died before the second write");
		};
		const key = harness.enqueue({ kind: "RELEASE", jobId: approved.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		assert.deepEqual(writes, []);
		assert.equal(harness.effectState(key).kind, "NEEDS_HUMAN");
		assert.equal(harness.effectState(key).reason, "SETTLEMENT_MISMATCH");
		assert.match(String(harness.effectState(key).detail), /RELEASE_COMPLETED for capture OTHERCAPTURE/);
		assert.equal((await harness.row()).state.status, "VERIFIED");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("the day-21 cutoff never switches a verified refund into a release", () => {
	// A verified row can be waiting on a refund. The cutoff is a hard stop on the escrow, not a switch of
	// sides: the selected refund stands, and the unconfirmed settlement is reported for a person.
	const verified = verifiedRow();
	const state = verified.state as Extract<typeof verified.state, { status: "VERIFIED" }>;
	const refunding: JobRow = { ...verified, state: { ...state, review: { phase: "REFUND_PENDING",
		refund: { reason: "ARBITER_REFUND", selectedAt: now } } } };
	// The refund's own effect settles it, so the capture-age cutoff is the only clock left.
	assert.equal(wakeAt(refunding), cutoff);
	const due = applyJobCommand(refunding, { type: "TimerDue", jobId: refunding.id, expectedWakeAt: cutoff }, { ...timer, now: cutoff });
	if (typeof due === "string") throw new Error(due);
	assert.equal(due.next.state.status, "VERIFIED");
	const review = (due.next.state as Extract<typeof due.next.state, { status: "VERIFIED" }>).review;
	assert.equal(review.phase, "REFUND_PENDING");
	assert.deepEqual(due.effects, [{ kind: "ALERT", jobId: refunding.id, reason: "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" }]);
	assert.equal(wakeAt(due.next), null);
});

test("a refund a verified row selected is still wanted, and settles the row", async () => {
	const verified = verifiedRow();
	const state = verified.state as Extract<typeof verified.state, { status: "VERIFIED" }>;
	const refunding: JobRow = { ...verified, state: { ...state, review: { phase: "REFUND_PENDING",
		refund: { reason: "ARBITER_REFUND", selectedAt: now } } } };
	const harness = moneyHarness(refunding, { paypal: {
		dispatch: async call => call.kind === "REFUND"
			? { kind: "CONFIRMED", observation: { kind: "REFUND_COMPLETED", refund: refundEvidence() } }
			: (() => { throw new Error(`Unexpected ${call.kind}`); })() as never,
		reconcile: async () => ({ kind: "NOT_FOUND" }),
	} });
	try {
		const key = harness.enqueue({ kind: "REFUND", jobId: refunding.id, captureId: "TESTCAPTURE" as CaptureId,
			payee: merchant, amount: usd("420.00") });
		assert.equal(await runOutboxOnce(harness.ports, key), "WORKED");
		// The row holds the disposition, so the effect is dispatched and settled, never acknowledged unseen.
		assert.equal((await harness.row()).state.status, "REFUNDED");
		assert.equal(harness.effectState(key).kind, "CONFIRMED");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("the refund settles from the provider and the retained fee goes back as a payout", async () => {
	const exhausted = exhaustedRow();
	const reimbursement = { batchId: payoutBatchId, itemId: payoutItemId, merchant, paid: usd("15.15"), fee: usd("0.25"), at: later };
	const calls: string[] = [];
	const harness = moneyHarness(exhausted, { paypal: {
		dispatch: async call => {
			calls.push(`${call.kind}:${call.kind === "REFUND" ? call.amount : ""}`);
			if (call.kind === "REFUND") return { kind: "CONFIRMED", observation: { kind: "REFUND_COMPLETED", refund: refundEvidence() } };
			if (call.kind === "REIMBURSE") return { kind: "CONFIRMED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement } };
			throw new Error(`Unexpected ${call.kind}`);
		},
		reconcile: async () => ({ kind: "NOT_FOUND" }),
	} });
	try {
		const refundKey = harness.enqueue({ kind: "REFUND", jobId: exhausted.id, captureId: "TESTCAPTURE" as CaptureId,
			payee: merchant, amount: usd("420.00") });
		assert.equal(await runOutboxOnce(harness.ports, refundKey), "WORKED");
		const refunded = await harness.row();
		assert.equal(refunded.state.status, "REFUNDED");
		assert.deepEqual(harness.effectKinds(), ["REFUND", "REIMBURSE"]);
		// The payout's sender batch id is the same deterministic effect key the outbox holds.
		const payoutKey = operationKey({ kind: "REIMBURSE", jobId: exhausted.id, merchant, amount: usd("15.15") });
		assert.equal(await runOutboxOnce(harness.ports, payoutKey), "WORKED");
		const paid = (await harness.row()).state as Extract<JobRow["state"], { status: "REFUNDED" }>;
		assert.deepEqual(paid.treasury.at(-1), { kind: "PAYOUT_FEE_PAID", jobId: exhausted.id, batchId: payoutBatchId,
			paid: 1515, fee: 25, at: later });
		assert.equal(harness.effectState(payoutKey).kind, "CONFIRMED");
		assert.deepEqual(calls, ["REFUND:42000", "REIMBURSE:"]);
		// A refund that is no longer pending is never dispatched: the row is the guard.
		assert.equal(await runOutboxOnce(harness.ports, refundKey), "IDLE");
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("the merge effect finishes the paid job, and a conflict parks it for a human", async () => {
	const released = applyJobCommand(approvedRow(), { type: "ReleaseSettled", jobId: "job_submit" as JobId, release: releaseEvidence() }, system);
	if (typeof released === "string") throw new Error(released);
	const paid = released.next;
	const effect: JobEffect = { kind: "MERGE", jobId: paid.id, pullRequest: 13, mergeCommit: approvedCommit, repository: "maya-client/invoice-app" };
	const merged = moneyHarness(paid, { merge: async () => ({ outcome: "MERGED", sha: landedCommit }) });
	try {
		const key = merged.enqueue(effect);
		assert.equal(await runOutboxOnce(merged.ports, key), "WORKED");
		const row = await merged.row();
		const state = row.state as Extract<JobRow["state"], { status: "PAID" }>;
		// The receipt names the tree the client approved; the merge names the commit GitHub made of it.
		assert.equal(state.receipt.mergeCommit, approvedCommit);
		assert.deepEqual(state.merge, { phase: "MERGED", at: now, sha: landedCommit });
		assert.deepEqual(projectJob(row, maya, new Map()).merge, { phase: "MERGED", at: now, sha: landedCommit });
		assert.equal(merged.effectState(key).kind, "CONFIRMED");
	} finally { merged.store.close(); merged.base.store.close(); }
	const conflicted = moneyHarness(paid, { merge: async () => ({ outcome: "CONFLICT" }) });
	try {
		const key = conflicted.enqueue(effect);
		assert.equal(await runOutboxOnce(conflicted.ports, key), "WORKED");
		const row = await conflicted.row();
		const state = row.state as Extract<JobRow["state"], { status: "PAID" }>;
		assert.deepEqual(state.merge, { phase: "NEEDS_HUMAN", reason: "GITHUB_MERGE_CONFLICT" });
		assert.deepEqual(projectJob(row, maya, new Map()).merge, { phase: "NEEDS_HUMAN", reason: "GITHUB_MERGE_CONFLICT" });
		assert.equal(conflicted.effectState(key).kind, "CONFIRMED");
	} finally { conflicted.store.close(); conflicted.base.store.close(); }
	const unknown = moneyHarness(paid, { merge: async () => ({ outcome: "UNKNOWN" }) });
	try {
		const key = unknown.enqueue(effect);
		assert.equal(await runOutboxOnce(unknown.ports, key), "WORKED");
		const state = (await unknown.row()).state as Extract<JobRow["state"], { status: "PAID" }>;
		assert.deepEqual(state.merge, { phase: "PENDING" });
		assert.equal(unknown.effectState(key).kind, "UNCERTAIN");
	} finally { unknown.store.close(); unknown.base.store.close(); }
});

test("a paid row stored before the merge carried a sha reads MERGED with a null sha", async () => {
	const released = applyJobCommand(approvedRow(), { type: "ReleaseSettled", jobId: "job_submit" as JobId, release: releaseEvidence() }, system);
	if (typeof released === "string") throw new Error(released);
	const paid = released.next;
	if (paid.state.status !== "PAID") throw new Error("Not paid");
	const store = new SqliteStore(":memory:");
	try {
		// The bytes a lane stored before the view named GitHub's merge commit: MERGED with no sha at all.
		const legacy = { ...paid, state: { ...paid.state, merge: { phase: "MERGED", at: later } } } as unknown as JobRow;
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(legacy.id, legacy.version, JSON.stringify(legacy), wakeAt(legacy));
		const read = await store.readJob(paid.id);
		if (read?.state.status !== "PAID") throw new Error("Missing the paid row");
		assert.deepEqual(read.state.merge, { phase: "MERGED", at: later, sha: null });
		assert.deepEqual(projectJob(read, maya, new Map()).merge, { phase: "MERGED", at: later, sha: null });
	} finally { store.close(); }
});

/** One delivery as posted. The route re-reads the resource the envelope points at, and trusts nothing else. */
const captureEnvelope = (eventId: string, captureId = "TESTCAPTURE") => JSON.stringify({ id: eventId,
	event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: captureId } });
const delivered = (ports: Ports, body: string) => ingestPayPalWebhook(ports, new Request("http://localhost:4310/paypal/webhook", { method: "POST", body }));
/** The answer every accepted delivery gets: no job, no status, no resource, no outcome. */
const accepted = { received: true } as const;
const refused = { received: false } as const;
type RecordedEvent = { readonly id: string; readonly eventType: string; readonly resourceType: string; readonly resourceId: string; readonly outcome: string };
const recordedEvents = (store: SqliteStore): readonly RecordedEvent[] => store.db.prepare("SELECT id, event_type, resource_type, resource_id, outcome FROM webhook_events ORDER BY rowid")
	.all().map(row => ({ id: String(row.id), eventType: String(row.event_type), resourceType: String(row.resource_type),
		resourceId: String(row.resource_id), outcome: String(row.outcome) }));
const recordedOutcome = (store: SqliteStore, id: string): string | null => recordedEvents(store).find(row => row.id === id)?.outcome ?? null;
/** A fixture job funded to IN_PROGRESS through the checkout edges, holding capture TESTCAPTURE. */
async function heldFixture() {
	const f = fixture();
	const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
	const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
		price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
	if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
	await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
	f.approve();
	assert.equal(await confirmFunding(f.ports, maya, job.id), true);
	const held = await f.store.readJob(job.id);
	if (held?.state.status !== "IN_PROGRESS") throw new Error("No held escrow");
	return { f, jobId: job.id, held };
}

test("a capture webhook completes a funding the inline path never confirmed", async () => {
	const f = fixture();
	try {
		const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
			price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
		if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
		// The buyer approved but the capture answer was lost, so the job waits in CAPTURING for the event.
		await applySystemCommand(f.ports, { type: "BuyerApproved", jobId: job.id, orderId: f.capture.orderId }, null, null);
		const waiting = await f.store.readJob(job.id);
		assert.equal(waiting?.state.status, "OPEN");
		assert.equal(f.captureCalls(), 0);
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const response = await delivered(f.ports, captureEnvelope("WH-CAPTURE-1"));
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), accepted);
		const held = await f.store.readJob(job.id);
		assert.equal(held?.state.status, "IN_PROGRESS");
		assert.equal(held?.version, (waiting?.version ?? 0) + 1);
		if (held?.state.status !== "IN_PROGRESS") throw new Error("No held escrow");
		assert.deepEqual(held.state.escrow.book, [{ kind: "HELD", cents: 42000, at: now }]);
		assert.deepEqual(recordedEvents(f.store), [{ id: "WH-CAPTURE-1", eventType: "PAYMENT.CAPTURE.COMPLETED",
			resourceType: "capture", resourceId: "TESTCAPTURE", outcome: "applied" }]);
	} finally { f.store.close(); }
});

test("a capture webhook is consumed once: a redelivery and a new event id change nothing", async () => {
	const { f, jobId, held } = await heldFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const first = await delivered(f.ports, captureEnvelope("WH-DUP-1"));
		// The job already holds this capture, so the edge is a no-op even on the first delivery of the fact.
		assert.equal(first.status, 202);
		assert.deepEqual(await first.json(), accepted);
		assert.equal(recordedOutcome(f.store, "WH-DUP-1"), "applied");
		assert.deepEqual(await f.store.readJob(jobId), held);
		const replay = await delivered(f.ports, captureEnvelope("WH-DUP-1"));
		assert.deepEqual(await replay.json(), accepted);
		assert.equal(recordedOutcome(f.store, "WH-DUP-1"), "no-op, job already IN_PROGRESS");
		const newId = await delivered(f.ports, captureEnvelope("WH-DUP-2"));
		assert.equal(newId.status, 202);
		assert.equal(recordedOutcome(f.store, "WH-DUP-2"), "no-op, job already IN_PROGRESS");
		assert.deepEqual(await f.store.readJob(jobId), held);
		assert.equal(f.captureCalls(), 1);
		assert.deepEqual(recordedEvents(f.store).map(row => [row.id, row.outcome]), [["WH-DUP-1", "no-op, job already IN_PROGRESS"], ["WH-DUP-2", "no-op, job already IN_PROGRESS"]]);
	} finally { f.store.close(); }
});

test("a capture webhook on a paid job is consumed once and never touches the paid book", async () => {
	const approved = approvedRow();
	const harness = moneyHarness(approved);
	try {
		// The resource index a committed capture writes, so the route resolves the capture to this job.
		harness.store.db.prepare("INSERT OR IGNORE INTO resources VALUES (?, ?)").run("TESTCAPTURE", approved.id);
		assert.deepEqual(await applySystemCommand(harness.ports, { type: "ReleaseSettled", jobId: approved.id, release: releaseEvidence() }, null, null),
			{ outcome: "COMMITTED", refused: null });
		const paid = await harness.row();
		assert.equal(paid.state.status, "PAID");
		if (paid.state.status !== "PAID") throw new Error("Not paid");
		harness.base.read("TESTCAPTURE", { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: harness.base.capture } });
		const first = await delivered(harness.ports, captureEnvelope("WH-PAID-1"));
		assert.equal(first.status, 202);
		assert.deepEqual(await first.json(), accepted);
		assert.equal(recordedOutcome(harness.store, "WH-PAID-1"), "applied");
		const replay = await delivered(harness.ports, captureEnvelope("WH-PAID-1"));
		assert.deepEqual(await replay.json(), accepted);
		assert.equal(recordedOutcome(harness.store, "WH-PAID-1"), "no-op, job already PAID");
		const newId = await delivered(harness.ports, captureEnvelope("WH-PAID-2"));
		assert.equal(recordedOutcome(harness.store, "WH-PAID-2"), "no-op, job already PAID");
		const after = await harness.row();
		assert.deepEqual(after.state.status === "PAID" ? after.state.book : null, paid.state.book);
		assert.deepEqual(recordedEvents(harness.store).map(row => [row.id, row.outcome]), [["WH-PAID-1", "no-op, job already PAID"], ["WH-PAID-2", "no-op, job already PAID"]]);
	} finally { harness.store.close(); harness.base.store.close(); }
});

test("a webhook fact the row refuses is recorded as a refusal and leaves the job alone", async () => {
	// The route re-reads a real refund on a job that never selected one. The row is the guard, so the
	// delivery is not an "applied" that changed nothing: the envelope records the refusal, and the row's
	// own mismatch alert is enqueued.
	const { f, jobId, held } = await heldFixture();
	try {
		f.read("REFUND1", { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: refundEvidence() } });
		const response = await delivered(f.ports, JSON.stringify({ id: "WH-REFUND-1", event_type: "PAYMENT.CAPTURE.REFUNDED",
			resource_type: "refund", resource: { id: "REFUND1" } }));
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), accepted);
		assert.deepEqual(await f.store.readJob(jobId), held);
		assert.equal(recordedOutcome(f.store, "WH-REFUND-1"), "refused, the job did not take this settlement");
		const alerts = f.store.db.prepare("SELECT json FROM outbox").all()
			.map(entry => (JSON.parse(String(entry.json)) as { effect: JobEffect }).effect)
			.filter(effect => effect.kind === "ALERT");
		assert.deepEqual(alerts.map(effect => effect.kind === "ALERT" ? effect.reason : null), ["SETTLEMENT_MISMATCH"]);
	} finally { f.store.close(); }
});

test("a webhook whose resource PayPal does not know is refused and no job moves", async () => {
	const { f, jobId, held } = await heldFixture();
	try {
		const response = await delivered(f.ports, captureEnvelope("WH-UNKNOWN-1", "CAPTURE_PAYPAL_NEVER_HAD"));
		// The answer is the same minimal body every delivery gets: an unauthenticated caller cannot tell
		// a resource PayPal holds from one it does not.
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), accepted);
		assert.deepEqual(await f.store.readJob(jobId), held);
		assert.deepEqual(recordedEvents(f.store), [{ id: "WH-UNKNOWN-1", eventType: "PAYMENT.CAPTURE.COMPLETED",
			resourceType: "capture", resourceId: "CAPTURE_PAYPAL_NEVER_HAD", outcome: "refused, PayPal does not know this capture" }]);
	} finally { f.store.close(); }
});

test("an event family the deployment does not route is recorded and dropped", async () => {
	const f = fixture();
	try {
		const response = await delivered(f.ports, JSON.stringify({ id: "WH-SALE-1", event_type: "PAYMENT.SALE.COMPLETED",
			resource_type: "sale", resource: { id: "SALE1" } }));
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), accepted);
		assert.deepEqual(recordedEvents(f.store), [{ id: "WH-SALE-1", eventType: "PAYMENT.SALE.COMPLETED",
			resourceType: "sale", resourceId: "SALE1", outcome: "no-op, event type not routed" }]);
	} finally { f.store.close(); }
});

test("a body that is not an event envelope is refused and still recorded", async () => {
	const f = fixture();
	try {
		const response = await delivered(f.ports, "not json");
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), refused);
		const rows = recordedEvents(f.store);
		assert.equal(rows.length, 1);
		assert.match(rows[0]?.id ?? "", /^unreadable-[0-9a-f]{16}$/);
		assert.deepEqual(rows[0], { id: rows[0]?.id, eventType: "", resourceType: "", resourceId: "", outcome: "refused, unreadable event" });
	} finally { f.store.close(); }
});

test("a delivery body is never stored: payer fields and the raw bytes stay out of the table", async () => {
	const { f } = await heldFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const body = JSON.stringify({ id: "WH-PII-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture",
			resource: { id: f.capture.captureId, payer: { email_address: "payer@example.test", payer_id: "PAYER1",
				name: { given_name: "Payer", surname: "Person" }, address: { address_line_1: "1 Payer Street", admin_area_2: "San Jose",
					admin_area_1: "CA", postal_code: "95131", country_code: "US" } } } });
		assert.equal((await delivered(f.ports, body)).status, 202);
		const rows = f.store.db.prepare("SELECT * FROM webhook_events").all();
		assert.equal(rows.length, 1);
		assert.deepEqual({ ...rows[0] }, { id: "WH-PII-1", received_at: now, event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource_type: "capture", resource_id: f.capture.captureId, outcome: "applied" });
		// Not one payer field, and not one raw byte of the body, is in the table.
		const stored = JSON.stringify(rows);
		for (const secret of ["payer@example.test", "PAYER1", "Payer", "Person", "1 Payer Street", "95131", "address_line_1", "payer_id"]) {
			assert.equal(stored.includes(secret), false, `${secret} reached the envelope table`);
		}
	} finally { f.store.close(); }
});

test("the webhook envelope table keeps a bounded window of deliveries", async () => {
	// The route is unauthenticated, so the window is pinned here as literals: the newest 500 deliveries,
	// and nothing older than 30 days.
	const retentionRows = 500;
	const retentionAgeMs = 30 * 86_400_000;
	const store = new SqliteStore(":memory:");
	try {
		for (let index = 0; index < retentionRows + 2; index++) await store.recordWebhookEvent({ id: `WH-${index}`,
			eventType: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: `C${index}`,
			receivedAt: instant(new Date(Date.parse(now) + index * 1000).toISOString()), outcome: "applied" });
		const count = () => Number(store.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()!.n);
		assert.equal(count(), retentionRows);
		// The oldest rows are the ones that go; the newest delivery is always kept.
		assert.equal(store.db.prepare("SELECT 1 FROM webhook_events WHERE id = 'WH-0'").get(), undefined);
		assert.notEqual(store.db.prepare("SELECT 1 FROM webhook_events WHERE id = ?").get(`WH-${retentionRows + 1}`), undefined);
		// An envelope older than the window ages out on the next insert instead of waiting for the cap.
		await store.recordWebhookEvent({ id: "WH-STALE", eventType: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture",
			resourceId: "C-STALE", receivedAt: instant(new Date(Date.parse(now) - retentionAgeMs - 1000).toISOString()), outcome: "applied" });
		assert.equal(store.db.prepare("SELECT 1 FROM webhook_events WHERE id = 'WH-STALE'").get(), undefined);
	} finally { store.close(); }
});
