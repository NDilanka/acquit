import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { commercialSplit, formatUsd, reduceLedger, usd } from "../src/ledger.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { executeCommand, applySystemCommand, confirmFunding, ingestVerifierCallback, operationKey, runDueTimers, runOutboxOnce } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { applyJobCommand, projectJob, storedDefinitionOfDone, TERMS, wakeAt } from "../src/job.ts";
import type { JobEffect, JobRow } from "../src/job.ts";
import { instant, hours, parseBidId, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, CommitSha, Digest, Instant, JobId, MerchantId, OperatorId, OrderId, CaptureId, Version } from "../src/ids.ts";
import type { RunFailure, Verdict, VerifierReport, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { createPayPal, parseCapture, quote } from "../src/paypal.ts";
import type { Bps, RemoteOutcome } from "../src/paypal.ts";
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
			parseWebhook: unimplemented,
		} };
	return { store, ports, capture, dispatches: () => dispatches, captureCalls: () => captureCalls,
		approve: () => { approved = true; }, advance: (at: string) => { currentNow = instant(at); } };
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
		await store.commit({ job: { expectedVersion: null, row: plan.next, wakeAt: instant("2026-10-06T15:00:00Z") }, operator: null, credits: [], outbox: [], acknowledge: null, request: null, delivery: null });
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
test("outbox acknowledgements use the store's injected clock", async () => {
	const store = new SqliteStore(":memory:", { now: () => now });
	try {
		const key = "test-key" as any;
		store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, "{}", "{}", null);
		await store.commit({ job: null, operator: null, credits: [], outbox: [], acknowledge: key, request: null, delivery: null });
		assert.deepEqual(JSON.parse(String(store.db.prepare("SELECT state FROM outbox").get()!.state)), { kind: "CONFIRMED", at: now });
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
	sourceCommit: source, reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], at: now });
const acceptance = (runId: string): Verdict => ({ result: "VERIFIED", runId: runId as VerifierRunId, sourceCommit,
	mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha, pullRequest: 13,
	frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now });
const system = { actor: { role: "SYSTEM", source: "VERIFIER" } as const, now, loaded: { kind: "NONE" } as const };
const verdictReport = (verdict: Verdict): VerifierReport => ({ kind: "VERDICT", verdict });
const runFailure = (runId: string, reason = "PUBLISH_FAILED: no App installation on maya-client", source = sourceCommit): RunFailure =>
	({ runId: runId as VerifierRunId, sourceCommit: source, reason, at: now });
const failureReport = (runId: string, reason?: string, source?: CommitSha): VerifierReport =>
	({ kind: "RUN_FAILED", failure: runFailure(runId, reason, source) });

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
	assert.equal(wakeAt(exhausted.next), null);
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
	for (const stale of [failureReport("run_submit_9"), failureReport("run_submit_1", "SOURCE_UNAVAILABLE", "f".repeat(40) as CommitSha)]) {
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
	// count stays put, and the reason is on the attempt so the CLI can name it instead of waiting.
	assert.deepEqual(attempts.failure, { runId: "run_submit_1", sourceCommit, reason: "RUN_DEADLINE_EXCEEDED", at: later });
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
	assert.deepEqual(view.attempts.history, [{ ordinal: 1, result: "VERIFIED", reasons: [], sourceCommit, at: now,
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
		sourceCommit, at: now, frozen: null, hidden: null, pullRequest: null }]);
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
