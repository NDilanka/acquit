// A bid the House cannot fund. The processor fee the House quotes at accept must fit inside the fee the split keeps,
// so a price under the floor cannot be accepted. Before this rule, a bid under the floor was stored PENDING, and the
// House client's accept threw on it. The throw aborted the whole tick, so every later account's pass was skipped and the
// outbox was not drained. These tests drive the real service over the scenario harness's fakes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDemoVisitor } from "../src/acquit.ts";
import type { Acquit, Actor } from "../src/acquit.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { HOUSE_CLIENT_ID, houseClientActor } from "../src/house-client.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, BidId, Instant, JobId, MerchantId, OperatorId, Version, VisitorId } from "../src/ids.ts";
import type { JobRow } from "../src/job.ts";
import { commercialSplit, usd } from "../src/ledger.ts";
import type { UsdCents } from "../src/ledger.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import { quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
import { newVisitorId } from "../src/visitors.ts";
import type { Harness } from "./scenario-harness.ts";
import { harness } from "./scenario-harness.ts";
import { demoFixture, jpyFixture } from "./hidden-fixture.ts";

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

/** A bid stored before this fix: its price is rewritten in the row, the way the old PlaceBid left it. */
function storeLegacyPrice(h: Harness, jobId: JobId, bidIndex: number, price: number): void {
	h.store.db.prepare("UPDATE jobs SET json = json_set(json, ?, ?) WHERE id = ?").run(`$.bids[${bidIndex}].price`, price, jobId);
}

/** The bids a job has chosen or been paid on: exactly one after the House accepts. */
const chosenOf = (row: JobRow): BidId[] => row.bids.filter(bid => bid.status === "CHOSEN" || bid.status === "ACCEPTED").map(bid => bid.id);

test("the lowest price the House can fund is 430 cents, and a bid one cent under it is refused", () => {
	const fundable = (price: number) => {
		try {
			quote(commercialSplit(price as UsdCents), feeModel);
			return true;
		} catch {
			return false;
		}
	};
	// By hand: at 430 the split keeps 22 + 43 = 65 and the order holds 452, so PayPal's fee is 16 + 49 = 65, which fits.
	// At 429 the split keeps 21 + 43 = 64 and PayPal's fee is 16 + 49 = 65, which does not.
	assert.equal(fundable(429), false);
	assert.equal(fundable(430), true);
	assert.equal(Array.from({ length: 1000 }, (_, index) => index + 1).find(fundable), 430);
});

test("PlaceBid refuses a price the House cannot fund, and accepts the lowest one it can", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const [first] = await startersOf(h, h.visitor.id);
		const jobId = first!.id;
		h.setClock(at(100));
		const agent = `${h.visitor.operatorHandle}-agent`;
		assert.deepEqual(await placeBid(h, operatorOf(h), jobId, 100, agent), { kind: "DENIED", reason: "PRICE_CANNOT_FUND" });
		assert.deepEqual(await placeBid(h, operatorOf(h), jobId, 429, agent), { kind: "DENIED", reason: "PRICE_CANNOT_FUND" });
		// A refused bid is not a bid: the operator's one bid on the job is still free.
		assert.equal((await rowOf(h, jobId)).bids.length, 0);
		const placed = await placeBid(h, operatorOf(h), jobId, 430, agent);
		assert.equal(placed.kind, "COMMITTED");
		assert.equal((await rowOf(h, jobId)).bids.length, 1);
	} finally { await h.dispose(); }
});

test("an accept that names a stored bid the House cannot fund is refused, and the row keeps its bid", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const [first] = await startersOf(h, h.visitor.id);
		const jobId = first!.id;
		h.setClock(at(100));
		const placed = await placeBid(h, operatorOf(h), jobId, 500, `${h.visitor.operatorHandle}-agent`);
		if (placed.kind !== "COMMITTED" || placed.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(placed)}`);
		storeLegacyPrice(h, jobId, 0, 100);
		// Starters belong to the House client, so the accept comes from its actor. It names the bid, so no pick is made.
		assert.deepEqual(await h.acquit.execute(houseClientActor(h.visitor.id, null), key(), { type: "AcceptBid", jobId, bidId: placed.result.bid }),
			{ kind: "DENIED", reason: "PRICE_CANNOT_FUND" });
		assert.equal((await rowOf(h, jobId)).state.status, "OPEN");
	} finally { await h.dispose(); }
});

test("the House accept skips a stored bid it cannot fund and chooses the lowest bid it can", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const [first] = await startersOf(h, h.visitor.id);
		const jobId = first!.id;
		h.setClock(at(100));
		const unfundable = await placeBid(h, operatorOf(h), jobId, 500, `${h.visitor.operatorHandle}-agent`);
		if (unfundable.kind !== "COMMITTED" || unfundable.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(unfundable)}`);
		storeLegacyPrice(h, jobId, 0, 100);
		const fundable = await placeBid(h, rivalIn(h.visitor.id), jobId, 500, "rival-agent");
		if (fundable.kind !== "COMMITTED" || fundable.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(fundable)}`);
		h.setClock(at(130));
		// The tick does not throw: the House client never reaches an accept it cannot quote.
		await h.acquit.tick();
		const row = await rowOf(h, jobId);
		assert.deepEqual(chosenOf(row), [fundable.result.bid]);
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
	} finally { await h.dispose(); }
});

test("a stored unfundable bid on one account does not stop the House pass for the next account", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const second = await createDemoVisitor(h.acquit, { id: newVisitorId(), ipKey: "bid-fundable-second", repository: null });
		if (second.kind !== "CREATED") throw new Error(`the second visitor was refused: ${second.kind}`);
		const [firstOfFirst] = await startersOf(h, h.visitor.id);
		const [firstOfSecond] = await startersOf(h, second.visitor.id);
		h.setClock(at(100));
		const legacy = await placeBid(h, operatorOf(h), firstOfFirst!.id, 500, `${h.visitor.operatorHandle}-agent`);
		if (legacy.kind !== "COMMITTED") throw new Error(`the bid was refused: ${JSON.stringify(legacy)}`);
		storeLegacyPrice(h, firstOfFirst!.id, 0, 100);
		const rival = await placeBid(h, rivalIn(second.visitor.id), firstOfSecond!.id, 500, "rival-agent");
		if (rival.kind !== "COMMITTED" || rival.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(rival)}`);
		h.setClock(at(130));
		await h.acquit.tick();
		assert.deepEqual(chosenOf(await rowOf(h, firstOfSecond!.id)), [rival.result.bid]);
		assert.deepEqual(chosenOf(await rowOf(h, firstOfFirst!.id)), []);
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
	} finally { await h.dispose(); }
});
