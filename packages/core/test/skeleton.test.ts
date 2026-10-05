import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { commercialSplit, formatUsd, usd } from "../src/ledger.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { executeCommand, applySystemCommand, confirmFunding, operationKey, runDueTimers, runOutboxOnce } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { applyJobCommand, TERMS } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { instant, hours, parseBidId, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, MerchantId, OperatorId, OrderId, CaptureId, Version } from "../src/ids.ts";
import { parseCapture, quote } from "../src/paypal.ts";
import type { Bps, RemoteOutcome } from "../src/paypal.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";

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
	const ports: Ports = { store, feeModel: model, clock: { now: () => currentNow }, verifier: { start: unimplemented, parseCallback: unimplemented },
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
