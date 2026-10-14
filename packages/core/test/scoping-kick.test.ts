// OpenJob's scoping kick: a fixture that carries a trusted fix gets its acceptance contract drafted
// the moment the job opens — once, and never for a fixture the deployment cannot scope.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { executeCommand } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, CommitSha, JobId, MerchantId, OperatorId, OrderId, Version } from "../src/ids.ts";
import type { FixtureContract } from "../src/fixtures.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";

const now = instant("2026-10-14T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const trustedFix = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-21T12:00:00Z") };

function jobIdOf(outcome: CommandOutcome): JobId {
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB") throw new Error("Expected a job result");
	return outcome.result.job.id;
}

async function portsFor(trusted: CommitSha | null): Promise<Ports> {
	const store = new SqliteStore(":memory:");
	const row: OperatorRow = { id: "house-ops" as OperatorId, handle: "house-ops", kind: "HOUSE", version: 0 as Version,
		payouts: { kind: "READY", merchant, connectedAt: now } };
	const agent: Agent = { id: "house-ts-fixer" as Agent["id"], owner: row.id, name: "house-ts-fixer",
		runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), 0);
	store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	return { store, feeModel: model, fixtures: [trusted === null ? demoFixture() : demoFixture(exampleContract, { trustedFix: trusted,
		coverageFamilies: [{ name: "three-decimal", currencies: ["BHD", "KWD"] }] })],
		clock: { now: () => now }, fundingMode: () => "checkout",
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented },
		alerts: { raise: unimplemented }, paypal: {
			dispatch: async () => ({ kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: "ORDER1" as OrderId,
				approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } }),
			reconcile: async () => ({ kind: "NOT_FOUND" }),
			getOrder: async () => ({ kind: "NOT_FOUND" }),
			parseWebhook: async () => ({ kind: "UNREADABLE", deliveryId: "test", detail: "no webhook in this fixture" }),
			verifyWebhookDelivery: unimplemented,
			readResource: async () => ({ kind: "UNKNOWN" }),
		} };
}

test("opening a job on a fixture with a trusted fix kicks exactly one scoping draft", async () => {
	const ports = await portsFor(trustedFix);
	const kicks: [JobId, FixtureContract][] = [];
	(ports as { scopeDraft?: unknown }).scopeDraft = async (jobId: JobId, fixture: FixtureContract) => { kicks.push([jobId, fixture]); };
	const opened = await executeCommand(ports, maya, parseRequestKey(randomUUID()), openCommand);
	assert.equal(opened.kind, "COMMITTED");
	const jobId = jobIdOf(opened);
	assert.equal(kicks.length, 1, "one open, one kick");
	assert.equal(kicks[0]![0], jobId);
	assert.equal(kicks[0]![1].trustedFix, trustedFix, "the kick carries the fixture's own trusted fix");
	assert.deepEqual(kicks[0]![1].coverageFamilies?.map(family => family.name), ["three-decimal"]);
});

test("opening a job on a fixture without a trusted fix never kicks a draft", async () => {
	const ports = await portsFor(null);
	const kicks: [JobId, FixtureContract][] = [];
	(ports as { scopeDraft?: unknown }).scopeDraft = async (jobId: JobId, fixture: FixtureContract) => { kicks.push([jobId, fixture]); };
	const opened = await executeCommand(ports, maya, parseRequestKey(randomUUID()), openCommand);
	assert.equal(opened.kind, "COMMITTED");
	assert.equal(kicks.length, 0, "no trusted fix, no draft");
});

test("a replayed open kicks nothing the second time", async () => {
	const ports = await portsFor(trustedFix);
	const kicks: [JobId, FixtureContract][] = [];
	(ports as { scopeDraft?: unknown }).scopeDraft = async (jobId: JobId, fixture: FixtureContract) => { kicks.push([jobId, fixture]); };
	const key = parseRequestKey(randomUUID());
	await executeCommand(ports, maya, key, openCommand);
	const replayed = await executeCommand(ports, maya, key, openCommand);
	assert.equal(replayed.kind, "REPLAY");
	assert.equal(kicks.length, 1, "the replay returns the recorded result and kicks nothing");
});
