// The agent exam gate at PlaceBid. Off by default, an unacquitted or wrong-task bid still lands;
// enforced, the same bids are refused by name. House bids pass either way, because placeHouseBid
// sends them through this same apply. The setter is process-wide, so every enforced case resets it.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { executeCommand } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { setExamGateEnforced } from "../src/job.ts";
import { withAgentDefaults } from "../src/operator.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import { SqliteStore } from "../src/store.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, ClientId, MerchantId, OperatorId, Version } from "../src/ids.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { HiddenContract } from "../src/fixtures.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const deploymentContract: HiddenContract = { ids: exampleContract.ids, digest: "c0".repeat(32) as HiddenContract["digest"] };

function grant(operator: OperatorId): CreditAccount {
	const empty: CreditAccount = { operator, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
	const granted = reduceCredits(empty, { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	if (typeof granted === "string") throw new Error(granted);
	return granted;
}

function fixture(agent: Partial<Pick<Agent, "task" | "acquittal">>, kind: "INDEPENDENT" | "HOUSE" = "INDEPENDENT") {
	const store = new SqliteStore(":memory:");
	const operator: OperatorRow = { id: "devon-ops" as OperatorId, handle: "devon-ops", kind, version: 0 as Version,
		payouts: { kind: "READY", merchant, connectedAt: now } };
	const full: Agent = { id: "ts-bugfixer" as AgentId, owner: operator.id, name: "ts-bugfixer", runner: "claude-code",
		promptDigest: "d".repeat(64) as Agent["promptDigest"], tools: [], task: "code" as Agent["task"], acquittal: null, sample: null, ...agent };
	const credits = grant(operator.id);
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), 0);
	store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(full.id, full.owner, JSON.stringify(full));
	store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(operator.id, credits.version, JSON.stringify(credits));
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, fixtures: [demoFixture(deploymentContract)], clock: { now: () => now },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented }, alerts: { raise: unimplemented },
		paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented,
			parseWebhook: unimplemented, verifyWebhookDelivery: unimplemented, readResource: unimplemented } };
	return { store, ports };
}

const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };

function openedJobId(outcome: CommandOutcome) {
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB") throw new Error("the open did not commit");
	return outcome.result.job.id;
}

async function placeBid(ports: Ports, jobId: ReturnType<typeof openedJobId>): Promise<CommandOutcome> {
	return executeCommand(ports, devon, parseRequestKey(randomUUID()),
		{ type: "PlaceBid", jobId, price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
}

async function openedAndBid(agent: Partial<Pick<Agent, "task" | "acquittal">>, kind: "INDEPENDENT" | "HOUSE" = "INDEPENDENT"): Promise<CommandOutcome> {
	const f = fixture(agent, kind);
	try {
		const jobId = openedJobId(await executeCommand(f.ports, maya, parseRequestKey(randomUUID()), openCommand));
		return await placeBid(f.ports, jobId);
	} finally { f.store.close(); }
}

test("off by default, the gate lets an unacquitted agent bid", async () => {
	const bid = await openedAndBid({ acquittal: null });
	assert.notEqual(bid.kind, "DENIED");
});

test("off by default, the gate lets a wrong-task agent bid", async () => {
	const bid = await openedAndBid({ task: "print-fdm" as Agent["task"], acquittal: null });
	assert.notEqual(bid.kind, "DENIED");
});

test("enforced, the gate refuses an unacquitted agent as NOT_ACQUITTED", async () => {
	setExamGateEnforced(true);
	try {
		const bid = await openedAndBid({ acquittal: null });
		assert.equal(bid.kind, "DENIED");
		if (bid.kind === "DENIED") assert.equal(bid.reason, "NOT_ACQUITTED");
	} finally { setExamGateEnforced(false); }
});

test("enforced, the gate refuses a wrong-task agent as WRONG_TASK", async () => {
	setExamGateEnforced(true);
	try {
		const bid = await openedAndBid({ task: "print-fdm" as Agent["task"], acquittal: { examId: "exam_1", at: now } });
		assert.equal(bid.kind, "DENIED");
		if (bid.kind === "DENIED") assert.equal(bid.reason, "WRONG_TASK");
	} finally { setExamGateEnforced(false); }
});

test("enforced, an acquitted agent on its own task bids", async () => {
	setExamGateEnforced(true);
	try {
		const bid = await openedAndBid({ acquittal: { examId: "exam_1", at: now } });
		assert.notEqual(bid.kind, "DENIED");
	} finally { setExamGateEnforced(false); }
});

test("enforced, House still bids without an acquittal", async () => {
	setExamGateEnforced(true);
	try {
		const bid = await openedAndBid({ acquittal: null }, "HOUSE");
		assert.notEqual(bid.kind, "DENIED");
	} finally { setExamGateEnforced(false); }
});

test("a row written before the exam reads with the code task, no acquittal, no sample", async () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("old-agent", "devon-ops",
			JSON.stringify({ id: "old-agent", owner: "devon-ops", name: "old-agent", runner: "claude-code",
				promptDigest: "d".repeat(64), tools: [] }));
		const agent = await store.readAgent("old-agent" as AgentId);
		assert(agent !== null);
		assert.equal(agent.task, "code");
		assert.equal(agent.acquittal, null);
		assert.equal(agent.sample, null);
	} finally { store.close(); }
	const filled = withAgentDefaults({ id: "a" as AgentId, owner: "devon-ops" as OperatorId, name: "a",
		runner: "codex", promptDigest: "d".repeat(64) as Agent["promptDigest"], tools: [] });
	assert.deepEqual({ task: filled.task, acquittal: filled.acquittal, sample: filled.sample }, { task: "code", acquittal: null, sample: null });
});
