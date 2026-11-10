// What the House pass does with a throw. A starter's act may fail in two ways. An ordinary failure — a locked
// database, a provider call without an answer, a fee refusal a stored bid can still raise — waits for the next tick,
// and the warning names the account or the job. A fault — a programming error, a corrupt row, a missing or malformed
// fee model — stops the pass, so a person looks instead of reading the same warning once a tick forever. These tests
// drive runHouseClients over ports built on the scenario harness's database, with faults injected at the store.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDemoVisitor } from "../src/acquit.ts";
import type { Acquit, Actor } from "../src/acquit.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { executeCommand } from "../src/effects.ts";
import { HOUSE_CLIENT_ID } from "../src/house-client.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, BidId, Instant, JobId, MerchantId, OperatorId, Version, VisitorId } from "../src/ids.ts";
import type { JobRow } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { UsdCents } from "../src/ledger.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Bps, FeeQuote, PayPal, PayPalCall, ProcessorFeeModel } from "../src/paypal.ts";
import { runHouseClients } from "../src/starters.ts";
import type { HouseClientPorts } from "../src/starters.ts";
import { SqliteStore } from "../src/store.ts";
import { newVisitorId } from "../src/visitors.ts";
import type { Harness } from "./scenario-harness.ts";
import { harness } from "./scenario-harness.ts";
import { demoFixture, DEMO_REPOSITORY, jpyFixture } from "./hidden-fixture.ts";

const EPOCH = Date.parse("2026-10-06T12:00:00Z");
const merchant = "sandbox-seller" as MerchantId;
const at = (seconds: number): Instant => instant(new Date(EPOCH + seconds * 1000).toISOString());
const key = () => parseRequestKey(randomUUID());
const fixtures = [demoFixture(), jpyFixture()];
// The harness's fee model. The harness does not export it, so it is written out here: 3.49% plus $0.49.
const feeModel = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };

const operatorOf = (h: Harness): Actor => ({ role: "OPERATOR", operatorId: h.visitor.operatorHandle as OperatorId, tenant: h.visitor.id });
/** The second independent operator, acting in the workspace whose starter it bids on. */
const rivalIn = (tenant: VisitorId): Actor => ({ role: "OPERATOR", operatorId: "rival-ops" as OperatorId, tenant });

/** The House operator and agent, and a second independent operator, as a seeded deployment holds them. */
function seedOperators(h: Harness): void {
	for (const [handle, kind, agentName] of [["house-tsfix", "HOUSE", "house-ts-fixer"], ["rival-ops", "INDEPENDENT", "rival-agent"]] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: at(0) } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [],
			task: "code" as Agent["task"], acquittal: { examId: "test", at: instant("2026-10-01T00:00:00.000Z") }, sample: null };
		const base: CreditAccount = { operator: row.id, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
		const credits = kind === "HOUSE" ? base : reduceCredits(base, { kind: "Grant", week: creditWeek(at(0)), paidReceipts: 0, at: at(0) });
		if (typeof credits === "string") throw new Error(credits);
		h.store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), 0);
		h.store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		h.store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
}

/** Ports for one direct pass, over a second store connection on the harness's database. */
function directPorts(store: SqliteStore, init: { at: Instant; feeModel?: ProcessorFeeModel; dispatches?: string[] }): HouseClientPorts {
	const sent = init.dispatches ?? [];
	// Every starter carries a stored card choice from its open, so its accept creates a card order, and the order's
	// first read answers captured, the way the harness's fake answers. The capture evidence comes from the stored quote.
	const quotes = new Map<string, FeeQuote>();
	return {
		store,
		feeModel: init.feeModel === undefined ? feeModel : init.feeModel,
		fixtures,
		clientRepository: DEMO_REPOSITORY,
		paypal: {
			dispatch: (call: PayPalCall) => {
				sent.push(call.kind);
				if (call.kind !== "CREATE_ORDER") return Promise.reject(new Error(`unexpected dispatch ${call.kind}`));
				const orderId = `ORDER-${call.jobId}`;
				quotes.set(orderId, call.quote);
				return Promise.resolve({ kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId,
					approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER" } });
			},
			reconcile: () => Promise.resolve({ kind: "NOT_FOUND" }),
			getOrder: (orderId: string, payee: MerchantId) => {
				const stored = quotes.get(orderId);
				if (!stored) return Promise.resolve({ kind: "PENDING", checkAt: init.at });
				return Promise.resolve({ kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: {
					orderId, captureId: `CAPTURE-${orderId}`, payee, disbursement: "DELAYED", gross: stored.split.held,
					processorFee: stored.predictedProcessorFee, platformFee: stored.platformFeeInstruction,
					sellerNet: stored.split.operatorNet, capturedAt: init.at } } });
			},
		} as unknown as PayPal,
		verifier: { start: () => Promise.resolve(), parseCallback: () => Promise.resolve(null) },
		github: { merge: () => Promise.reject(new Error("not used by the House pass")) },
		alerts: { raise: () => Promise.resolve() },
		clock: { now: () => init.at },
		fundWithCard: () => {},
	};
}

/** A store whose read of one job raises the given fault: the way a locked row or a broken read reaches one starter's act. */
class FaultStore extends SqliteStore {
	private readonly faultFor: JobId;
	private readonly fault: () => Error;
	constructor(path: string, faultFor: JobId, fault: () => Error) {
		super(path);
		this.faultFor = faultFor;
		this.fault = fault;
	}
	override async readJob(id: JobId): Promise<JobRow | null> {
		if (id === this.faultFor) throw this.fault();
		return super.readJob(id);
	}
}

async function startersOf(h: Harness, tenant: VisitorId): Promise<readonly JobRow[]> {
	return (await h.store.listJobs()).filter(row => row.tenant === tenant && row.client === HOUSE_CLIENT_ID)
		.toSorted((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
}

async function rowOf(h: Harness, jobId: JobId): Promise<JobRow> {
	const row = await h.store.readJob(jobId);
	if (!row) throw new Error(`no row for ${jobId}`);
	return row;
}

function placeBid(h: Harness, actor: Actor, jobId: JobId, price: number, agent: string): ReturnType<Acquit["execute"]> {
	return h.acquit.execute(actor, key(), { type: "PlaceBid", jobId, price: price as UsdCents, eta: hours(48), agent: agent as AgentId, pitch: "starter bid" });
}

/** The bids a job has chosen or been paid on: exactly one after the House accepts. */
const chosenOf = (row: JobRow): BidId[] => row.bids.filter(bid => bid.status === "CHOSEN" || bid.status === "ACCEPTED").map(bid => bid.id);

/** console.warn captured for one block, so a test can name the line the pass logged. */
async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
	try {
		return { result: await run(), warnings };
	} finally { console.warn = original; }
}

test("PlaceBid with no fee model wired fails loudly, instead of refusing the bid as unfundable", async () => {
	const h = await harness({ fixtures });
	const store = new SqliteStore(h.path);
	try {
		const [first] = await startersOf(h, h.visitor.id);
		const ports = directPorts(store, { at: at(100), feeModel: null as unknown as ProcessorFeeModel });
		const agent = `${h.visitor.operatorHandle}-agent` as AgentId;
		await assert.rejects(
			executeCommand(ports, operatorOf(h), key(), { type: "PlaceBid", jobId: first!.id, price: 500 as UsdCents, eta: hours(48), agent, pitch: "starter bid" }),
			(error: unknown) => error instanceof Error && error.message === "Invalid fee model: none is configured");
	} finally { store.close(); await h.dispose(); }
});

test("PlaceBid with a malformed fee model fails loudly, instead of refusing the bid as unfundable", async () => {
	const h = await harness({ fixtures });
	const store = new SqliteStore(h.path);
	try {
		const [first] = await startersOf(h, h.visitor.id);
		const ports = directPorts(store, { at: at(100), feeModel: { version: "bad", rateBps: -1 as Bps, fixed: usd("0.49") } });
		const agent = `${h.visitor.operatorHandle}-agent` as AgentId;
		await assert.rejects(
			executeCommand(ports, operatorOf(h), key(), { type: "PlaceBid", jobId: first!.id, price: 500 as UsdCents, eta: hours(48), agent, pitch: "starter bid" }),
			(error: unknown) => error instanceof Error && error.message === "Invalid fee model");
	} finally { store.close(); await h.dispose(); }
});

test("a missing fee model stops the House pass instead of waiting for the next tick forever", async () => {
	const h = await harness({ fixtures });
	const store = new SqliteStore(h.path);
	try {
		seedOperators(h);
		const [first] = await startersOf(h, h.visitor.id);
		h.setClock(at(100));
		const placed = await placeBid(h, operatorOf(h), first!.id, 500, `${h.visitor.operatorHandle}-agent`);
		if (placed.kind !== "COMMITTED") throw new Error(`the bid was refused: ${JSON.stringify(placed)}`);
		const ports = directPorts(store, { at: at(130), feeModel: null as unknown as ProcessorFeeModel });
		const { warnings } = await captureWarnings(async () => {
			await assert.rejects(runHouseClients(ports, [{ id: h.visitor.id, repository: null }]),
				(error: unknown) => error instanceof Error && error.message === "Invalid fee model: none is configured");
		});
		assert.equal(warnings.length, 0);
	} finally { store.close(); await h.dispose(); }
});

test("a locked row in one starter's act waits for the next tick, and the next account still accepts", async () => {
	const h = await harness({ fixtures });
	let store: FaultStore | null = null;
	try {
		seedOperators(h);
		const second = await createDemoVisitor(h.acquit, { id: newVisitorId(), ipKey: "house-pass-errors-second", repository: null });
		if (second.kind !== "CREATED") throw new Error(`the second visitor was refused: ${second.kind}`);
		const [firstOfFirst] = await startersOf(h, h.visitor.id);
		const [firstOfSecond] = await startersOf(h, second.visitor.id);
		h.setClock(at(100));
		const own = await placeBid(h, operatorOf(h), firstOfFirst!.id, 500, `${h.visitor.operatorHandle}-agent`);
		if (own.kind !== "COMMITTED") throw new Error(`the bid was refused: ${JSON.stringify(own)}`);
		const rival = await placeBid(h, rivalIn(second.visitor.id), firstOfSecond!.id, 500, "rival-agent");
		if (rival.kind !== "COMMITTED" || rival.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(rival)}`);
		// node:sqlite reports a lock as errcode 5 once busy_timeout has passed, the transient the webhook answers 503 to.
		store = new FaultStore(h.path, firstOfFirst!.id, () => Object.assign(new Error("database is locked"), { errcode: 5 }));
		const dispatches: string[] = [];
		const { result: acted, warnings } = await captureWarnings(() =>
			runHouseClients(directPorts(store!, { at: at(130), dispatches }), [{ id: h.visitor.id, repository: null }, { id: second.visitor.id, repository: null }]));
		assert.equal(acted, 1);
		assert.deepEqual(chosenOf(await rowOf(h, firstOfSecond!.id)), [rival.result.bid]);
		assert.deepEqual(chosenOf(await rowOf(h, firstOfFirst!.id)), []);
		assert.deepEqual(dispatches, ["CREATE_ORDER"]);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0]!.includes(firstOfFirst!.id) && warnings[0]!.includes("database is locked"), `the warning names the job: ${warnings[0]}`);
	} finally { store?.close(); await h.dispose(); }
});

test("a programming error in a starter's act stops the pass, and no warning calls it ordinary", async () => {
	const h = await harness({ fixtures });
	let store: FaultStore | null = null;
	try {
		seedOperators(h);
		const [first] = await startersOf(h, h.visitor.id);
		h.setClock(at(100));
		const placed = await placeBid(h, operatorOf(h), first!.id, 500, `${h.visitor.operatorHandle}-agent`);
		if (placed.kind !== "COMMITTED") throw new Error(`the bid was refused: ${JSON.stringify(placed)}`);
		store = new FaultStore(h.path, first!.id, () => new TypeError("Cannot read properties of undefined (reading 'bids')"));
		const { warnings } = await captureWarnings(async () => {
			await assert.rejects(runHouseClients(directPorts(store!, { at: at(130) }), [{ id: h.visitor.id, repository: null }]),
				(error: unknown) => error instanceof TypeError);
		});
		assert.equal(warnings.length, 0);
	} finally { store?.close(); await h.dispose(); }
});

test("a corrupt job row stops the pass at the account level", async () => {
	const h = await harness({ fixtures });
	const store = new SqliteStore(h.path);
	try {
		const [first] = await startersOf(h, h.visitor.id);
		h.store.db.prepare("UPDATE jobs SET json = '{' WHERE id = ?").run(first!.id);
		await assert.rejects(runHouseClients(directPorts(store, { at: at(130) }), [{ id: h.visitor.id, repository: null }]),
			(error: unknown) => error instanceof SyntaxError);
	} finally { store.close(); await h.dispose(); }
});
