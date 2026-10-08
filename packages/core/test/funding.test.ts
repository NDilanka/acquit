// A job's funding source is the job's own. The preference its client stored decides the order its
// accept queues, a job nobody chose for funds with the deployment's mode, and neither job's choice
// reaches the other's. AcceptBid's loader is the only reader; the routes are the only writer.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { executeCommand } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { defaultJobFunding, jobFunding, setJobFunding } from "../src/funding.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, Digest, JobId, MerchantId, OperatorId, OrderId, Version } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { SqliteStore } from "../src/store.ts";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId };
const requestKey = () => parseRequestKey(randomUUID());
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };

function jobIdOf(outcome: CommandOutcome): JobId {
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB") throw new Error("Expected a job result");
	return outcome.result.job.id;
}
/** The operator's own rows plus the house's, so OpenJob's house bid and an independent bid both work. */
function fixture() {
	const store = new SqliteStore(":memory:");
	for (const [handle, kind, agentName] of [
		["devon-ops", "INDEPENDENT", "ts-bugfixer"], ["house-tsfix", "HOUSE", "house-ts-fixer"],
	] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: now } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		const base: CreditAccount = { operator: row.id, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
		const credits = kind === "HOUSE" ? base : reduceCredits(base, { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
		if (typeof credits === "string") throw new Error(credits);
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), 0);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
	/** Every order the outbox created, as the funding source the effect bound to it. */
	const orders: string[] = [];
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, clientRepository: "maya-client/invoice-app",
		hiddenContract: { ids: [], digest: "c0".repeat(32) as Digest }, clock: { now: () => now }, fundingMode: () => "checkout",
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented },
		alerts: { raise: unimplemented }, paypal: {
			dispatch: async call => {
				if (call.kind !== "CREATE_ORDER") throw new Error("Unexpected test effect");
				orders.push(call.fundingMode ?? "checkout");
				return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: `ORDER${orders.length}` as OrderId,
					approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } };
			},
			reconcile: async () => ({ kind: "NOT_FOUND" }),
			getOrder: async () => ({ kind: "NOT_FOUND" }),
			parseWebhook: async () => ({ kind: "UNREADABLE", deliveryId: "test", detail: "no webhook in this fixture" }),
			readResource: async () => ({ kind: "UNKNOWN" }),
		} };
	return { store, ports, orders };
}
/** Opens a job for the fixture's client, has devon bid on it, and accepts that bid. */
async function bidAndAccept(f: ReturnType<typeof fixture>): Promise<JobId> {
	const opened = await executeCommand(f.ports, maya, requestKey(), openCommand);
	const jobId = jobIdOf(opened);
	const placed = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId, price: usd("400.00"),
		eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "funding fixture" });
	if (placed.kind === "DENIED" || placed.result.kind !== "BID") throw new Error("Missing bid");
	const accepted = await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId, bidId: placed.result.bid });
	assert.notEqual(accepted.kind, "DENIED", JSON.stringify(accepted));
	return jobId;
}

test("a job funds with the mode its client chose, and a job nobody chose for funds with the deployment's", async () => {
	const f = fixture();
	try {
		// The client chose the test card for the first job before accepting a bid on it.
		const cardJob = jobIdOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
		assert.equal(jobFunding(f.store.db, cardJob), null, "A fresh job carries no preference.");
		setJobFunding(f.store.db, cardJob, "card", now);
		assert.equal(jobFunding(f.store.db, cardJob), "card");
		assert.equal((await f.store.readJob(cardJob))?.funding, "card", "The loaded row carries the job's own mode.");
		const cardBid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: cardJob, price: usd("400.00"),
			eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "card job" });
		if (cardBid.kind === "DENIED" || cardBid.result.kind !== "BID") throw new Error("Missing bid");
		await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: cardJob, bidId: cardBid.result.bid });
		assert.deepEqual(f.orders, ["card"], "The accepted bid queued the order with the job's own mode.");

		// The second job was never chosen for, so it funds with the deployment's mode.
		const defaultJob = await bidAndAccept(f);
		assert.deepEqual(f.orders, ["card", "checkout"]);
		assert.equal(jobFunding(f.store.db, defaultJob), null);
		assert.equal((await f.store.readJob(defaultJob))?.funding, null, "A job nobody chose for carries no preference.");

		// The deployment's own default never overwrites a choice the client already made.
		defaultJobFunding(f.store.db, cardJob, "checkout", now);
		assert.equal(jobFunding(f.store.db, cardJob), "card");
	} finally { f.store.close(); }
});
test("the mode a job queues is the one stored when the bid was accepted, not one chosen later", async () => {
	const f = fixture();
	try {
		const jobId = await bidAndAccept(f);
		assert.deepEqual(f.orders, ["checkout"]);
		// The order is already queued: changing the preference cannot rewrite it.
		setJobFunding(f.store.db, jobId, "card", now);
		assert.deepEqual(f.orders, ["checkout"], "A queued order keeps the mode it was created under.");
	} finally { f.store.close(); }
});
