// The House client in a lasting account's workspace: it opens the starter jobs, accepts the best bid on one
// about 30 seconds after the account's operator bids, and approves the verified work about 60 seconds later,
// all through the commands a person sends. Every test drives the real service over the scenario harness's
// fakes and checks the money conserves on every job it touched.

import assert from "node:assert/strict";
import test from "node:test";
import { starterStatus } from "../src/acquit.ts";
import type { Acquit, Actor } from "../src/acquit.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { derivedRequestKey } from "../src/effects.ts";
import { HOUSE_CLIENT_ID, houseClientActor } from "../src/house-client.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, BidId, ClientId, Instant, JobId, MerchantId, OperatorId, Version } from "../src/ids.ts";
import { projectJob } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { UsdCents } from "../src/ledger.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { DisputeId } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { starterPool } from "../src/starters.ts";
import type { Harness } from "./scenario-harness.ts";
import { harness } from "./scenario-harness.ts";
import { demoFixture, jpyFixture } from "./hidden-fixture.ts";
import { randomUUID } from "node:crypto";

const EPOCH = Date.parse("2026-10-06T12:00:00Z");
const merchant = "sandbox-seller" as MerchantId;
const platform: Actor = { role: "PLATFORM" };
const at = (seconds: number): Instant => instant(new Date(EPOCH + seconds * 1000).toISOString());
const key = () => parseRequestKey(randomUUID());
const fixtures = [demoFixture(), jpyFixture()];

const clientOf = (h: Harness): Actor => ({ role: "CLIENT", clientId: h.visitor.clientHandle as ClientId, tenant: h.visitor.id });
const operatorOf = (h: Harness): Actor => ({ role: "OPERATOR", operatorId: h.visitor.operatorHandle as OperatorId, tenant: h.visitor.id });

/** The House operator and agent, and a second independent operator, as a seeded deployment holds them. */
function seedOperators(h: Harness): void {
	for (const [handle, kind, agentName] of [["house-tsfix", "HOUSE", "house-ts-fixer"], ["rival-ops", "INDEPENDENT", "rival-agent"]] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: at(0) } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		const base: CreditAccount = { operator: row.id, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
		const credits = kind === "HOUSE" ? base : reduceCredits(base, { kind: "Grant", week: creditWeek(at(0)), paidReceipts: 0, at: at(0) });
		if (typeof credits === "string") throw new Error(credits);
		h.store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), 0);
		h.store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		h.store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
}

async function startersOf(h: Harness, tenant = h.visitor.id): Promise<readonly JobRow[]> {
	return (await h.store.listJobs()).filter(row => row.tenant === tenant && row.client === HOUSE_CLIENT_ID)
		.toSorted((a, b) => a.openedAt.localeCompare(b.openedAt)
			|| (a.contract.definitionOfDone?.issue.number ?? 0) - (b.contract.definitionOfDone?.issue.number ?? 0));
}

async function rowOf(h: Harness, jobId: JobId): Promise<JobRow> {
	const row = await h.store.readJob(jobId);
	if (!row) throw new Error(`no row for ${jobId}`);
	return row;
}

async function bid(service: Acquit, actor: Actor, jobId: JobId, price: UsdCents, agent: string): Promise<BidId> {
	const outcome = await service.execute(actor, key(), { type: "PlaceBid", jobId, price, eta: hours(48), agent: agent as AgentId, pitch: "starter bid" });
	if (outcome.kind !== "COMMITTED" || outcome.result.kind !== "BID") throw new Error(`the bid was refused: ${JSON.stringify(outcome)}`);
	return outcome.result.bid;
}

/** Ticks until the predicate holds, for the verifier's callback, which lands on its own turn. */
async function until(h: Harness, jobId: JobId, predicate: (row: JobRow) => boolean): Promise<JobRow> {
	for (let i = 0; i < 200; i++) {
		await h.acquit.tick();
		const row = await rowOf(h, jobId);
		if (predicate(row)) return row;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`${jobId} never reached the state the test waits for`);
}

/** held = released + refunded + fees on every job the deployment holds, and on each settled job alone. */
async function assertConserves(service: Acquit): Promise<{ held: number; released: number; refunded: number; fees: number; funded: number }> {
	const answer = await service.query(platform, { type: "PlatformTables" });
	if (answer.kind !== "PLATFORM_TABLES") throw new Error("the platform tables were refused");
	const jobs = answer.tables.jobs;
	for (const job of jobs) {
		assert.equal(job.grossCents, job.heldCents + job.releasedCents + job.refundedCents + job.feeCents, `${job.jobId} conserves`);
	}
	const sum = (pick: (job: (typeof jobs)[number]) => number) => jobs.reduce((total, job) => total + pick(job), 0);
	const totals = { held: sum(job => job.heldCents), released: sum(job => job.releasedCents), refunded: sum(job => job.refundedCents),
		fees: sum(job => job.feeCents), funded: sum(job => job.grossCents) };
	assert.equal(totals.funded, totals.held + totals.released + totals.refunded + totals.fees);
	return totals;
}

/** Bids on the first starter as the account's operator at the given second, and runs the House client's accept 30 s later. */
async function wonStarter(h: Harness): Promise<{ jobId: JobId; bidId: BidId }> {
	const [first] = await startersOf(h);
	h.setClock(at(100));
	const bidId = await bid(h.acquit, operatorOf(h), first!.id, usd("400.00"), `${h.visitor.operatorHandle}-agent`);
	h.setClock(at(130));
	await h.acquit.tick();
	await until(h, first!.id, row => row.state.status === "IN_PROGRESS" && row.state.attempts.phase === "READY");
	return { jobId: first!.id, bidId };
}

/** Delivers the honest fix and waits for the verdict; the verifier's callback lands at the clock's current instant. */
async function verified(h: Harness, jobId: JobId): Promise<JobRow> {
	const sourceCommit = await h.deps.workspace.push(jobId, "honest-reference-table");
	const submitted = await h.acquit.execute(operatorOf(h), key(), { type: "Submit", jobId, sourceCommit });
	assert.equal(submitted.kind, "COMMITTED");
	return until(h, jobId, row => row.state.status === "VERIFIED");
}

test("a lasting account opens with two starter jobs from two distinct issues, funded by card, once", async () => {
	const h = await harness({ fixtures });
	try {
		const opened = await startersOf(h);
		assert.deepEqual(opened.map(row => ({ issue: row.contract.definitionOfDone?.issue.number, budget: row.contract.budget, tenant: row.tenant,
			client: row.client, funding: row.funding, title: row.title, status: row.state.status })), [
			{ issue: 12, budget: 40000, tenant: h.visitor.id, client: "house-client", funding: "card", title: "Totals round wrong for 3-decimal currencies", status: "OPEN" },
			{ issue: 13, budget: 40000, tenant: h.visitor.id, client: "house-client", funding: "card", title: "Totals round wrong for JPY", status: "OPEN" },
		]);
		// Further passes, a restarted process, and the replayed opening keys all leave the pair as it is.
		await h.acquit.tick();
		await h.reopen().tick();
		assert.equal((await startersOf(h)).length, 2);
		// The account's operator reads them marked as starters, and they never spend the account's own job allowance.
		const listed = await h.acquit.query(operatorOf(h), { type: "OpenJobs", cursor: null });
		if (listed.kind !== "JOBS") throw new Error("the list was refused");
		assert.deepEqual(listed.jobs.map(job => ({ starter: job.starter, client: job.client })), [
			{ starter: true, client: null }, { starter: true, client: null }]);
		for (let i = 0; i < 3; i++) {
			const own = await h.acquit.execute(clientOf(h), key(), { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
				budget: usd("50.00"), deliveryEndsAt: at(86_400) });
			assert.equal(own.kind, "COMMITTED", `the account's own job ${i + 1} opens`);
		}
		const mine = await h.acquit.query(clientOf(h), { type: "OpenJobs", cursor: null });
		if (mine.kind !== "JOBS") throw new Error("the list was refused");
		assert.deepEqual(mine.jobs.map(job => job.starter).toSorted(), [false, false, false, true, true]);
		assert.deepEqual(await starterStatus(h.acquit, h.visitor.id), { open: 2, openedToday: 2, dailyLimit: 6, capped: false });
		assert.deepEqual(await assertConserves(h.acquit), { held: 0, released: 0, refunded: 0, fees: 0, funded: 0 });
	} finally { await h.dispose(); }
});

test("a scenario run's visitor and the seeded world get no starter jobs", async () => {
	const h = await harness({ fixtures });
	try {
		const run = await h.provision(h.visitor);
		if (run.kind !== "CREATED") throw new Error("the scenario visitor was refused");
		await h.acquit.tick();
		assert.equal((await startersOf(h, run.visitor.id)).length, 0);
		assert.equal((await h.store.listJobs()).filter(row => row.tenant === null).length, 0);
		assert.equal((await h.store.listJobs()).filter(row => row.client === HOUSE_CLIENT_ID).length, 2, "only the lasting account's pair");
		await assertConserves(h.acquit);
	} finally { await h.dispose(); }
});

test("the House agent bids on the account's own job and never on a starter job", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const own = await h.acquit.execute(clientOf(h), key(), { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: usd("50.00"), deliveryEndsAt: at(86_400) });
		if (own.kind !== "COMMITTED" || own.result.kind !== "JOB") throw new Error("the account's job was refused");
		await h.acquit.tick();
		assert.deepEqual((await startersOf(h)).map(row => row.bids.length), [0, 0]);
		assert.deepEqual((await rowOf(h, own.result.job.id)).bids.map(row => row.kind), ["HOUSE"]);
		await assertConserves(h.acquit);
	} finally { await h.dispose(); }
});

test("the House client accepts the lowest bid 30 seconds after the first, by card, once across passes, a restart, and a replay", async () => {
	const h = await harness({ fixtures });
	try {
		seedOperators(h);
		const [first] = await startersOf(h);
		const jobId = first!.id;
		h.setClock(at(100));
		await bid(h.acquit, operatorOf(h), jobId, usd("400.00"), `${h.visitor.operatorHandle}-agent`);
		h.setClock(at(110));
		const rival = await bid(h.acquit, { role: "OPERATOR", operatorId: "rival-ops" as OperatorId, tenant: h.visitor.id }, jobId, usd("350.00"), "rival-agent");
		h.setClock(at(129));
		await h.acquit.tick();
		assert.equal((await rowOf(h, jobId)).state.status, "OPEN", "29 seconds after the first bid nothing is accepted");
		h.setClock(at(130));
		await h.acquit.tick();
		await h.reopen().tick();
		await h.acquit.tick();
		const row = await rowOf(h, jobId);
		if (row.state.status !== "IN_PROGRESS") throw new Error(`the starter is ${row.state.status}`);
		assert.equal(row.state.escrow.payee.bidId, rival);
		assert.equal(row.state.escrow.payee.price, 35000);
		assert.equal(row.state.escrow.book[0].cents, 36750);
		assert.deepEqual(row.bids.map(b => b.status), ["NOT_SELECTED", "ACCEPTED"]);
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
		// The same accept under the same derived key is the recorded answer, never a second order.
		const replay = await h.acquit.execute(houseClientActor(h.visitor.id, h.visitor.repository), derivedRequestKey(`${HOUSE_CLIENT_ID}:accept:${jobId}:0`),
			{ type: "AcceptBid", jobId });
		assert.equal(replay.kind, "REPLAY");
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
		assert.deepEqual(await assertConserves(h.acquit), { held: 36750, released: 0, refunded: 0, fees: 0, funded: 36750 });
	} finally { await h.dispose(); }
});

test("the House client accepts the lowest bid its accept commits, so a bid that lands after the pass read its snapshot is compared", async () => {
	const h = await harness({ fixtures });
	const readJobs = SqliteStore.prototype.listJobs;
	try {
		seedOperators(h);
		const [first] = await startersOf(h);
		const jobId = first!.id;
		h.setClock(at(100));
		await bid(h.acquit, operatorOf(h), jobId, usd("400.00"), `${h.visitor.operatorHandle}-agent`);
		// The House pass's own snapshot read returns the 40000 bid alone; a rival then bids 35000 before the accept reads the row.
		// The pass's read is told apart by its caller, so the tick's other reads of the table pass through unchanged.
		const injected = { rival: null as BidId | null };
		SqliteStore.prototype.listJobs = async function (this: SqliteStore) {
			const fromHousePass = new Error().stack?.includes("runHouseClient") === true;
			const rows = await readJobs.call(this);
			if (fromHousePass && injected.rival === null) {
				injected.rival = await bid(h.acquit, { role: "OPERATOR", operatorId: "rival-ops" as OperatorId, tenant: h.visitor.id }, jobId, usd("350.00"), "rival-agent");
			}
			return rows;
		};
		h.setClock(at(130));
		const row = await until(h, jobId, candidate => candidate.state.status === "IN_PROGRESS");
		assert.notEqual(injected.rival, null, "the rival bid committed after the snapshot");
		if (row.state.status !== "IN_PROGRESS") throw new Error(`the starter is ${row.state.status}`);
		assert.equal(row.state.escrow.payee.bidId, injected.rival);
		assert.equal(row.state.escrow.payee.price, 35000);
		assert.equal(row.state.escrow.book[0].cents, 36750);
		assert.deepEqual(row.bids.map(b => b.status), ["NOT_SELECTED", "ACCEPTED"]);
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
		assert.deepEqual(await assertConserves(h.acquit), { held: 36750, released: 0, refunded: 0, fees: 0, funded: 36750 });
		// Only the House client may accept without naming a bid: an operator's or a client's bare accept finds no bid.
		assert.deepEqual(await h.acquit.execute(clientOf(h), key(), { type: "AcceptBid", jobId }), { kind: "DENIED", reason: "NOT_FOUND" });
	} finally {
		SqliteStore.prototype.listJobs = readJobs;
		await h.dispose();
	}
});

test("the House client approves 60 seconds after Verified, once, and the operator is paid 360.00 USD", async () => {
	const h = await harness({ fixtures });
	try {
		const { jobId } = await wonStarter(h);
		h.setClock(at(200));
		const checked = await verified(h, jobId);
		if (checked.state.status !== "VERIFIED" || checked.state.review.phase !== "AWAITING_CLIENT") throw new Error("not awaiting review");
		h.setClock(at(259));
		await h.acquit.tick();
		assert.equal((await rowOf(h, jobId)).state.status, "VERIFIED", "59 seconds after Verified nothing is approved");
		h.setClock(at(260));
		await h.acquit.tick();
		await h.reopen().tick();
		const paid = await until(h, jobId, row => row.state.status === "PAID");
		if (paid.state.status !== "PAID") throw new Error("unpaid");
		assert.equal(paid.state.releaseAuthority, "CLIENT_APPROVAL");
		assert.equal(paid.state.receipt.paid, 36000);
		assert.equal(h.paypalDispatches.filter(kind => kind === "RELEASE").length, 1);
		const replay = await h.acquit.execute(houseClientActor(h.visitor.id, h.visitor.repository),
			derivedRequestKey(`${HOUSE_CLIENT_ID}:approve:${jobId}:${checked.state.passed.verdict.mergeCommit}`),
			{ type: "Approve", jobId, mergeCommit: checked.state.passed.verdict.mergeCommit });
		assert.equal(replay.kind, "REPLAY");
		assert.equal(h.paypalDispatches.filter(kind => kind === "RELEASE").length, 1);
		assert.deepEqual(await assertConserves(h.acquit), { held: 0, released: 36000, refunded: 0, fees: 6000, funded: 42000 });
	} finally { await h.dispose(); }
});

test("the House client does not approve while the review is disputed or PayPal holds the release", async () => {
	for (const hold of ["in-app dispute", "PayPal buyer dispute"] as const) {
		const h = await harness({ fixtures });
		try {
			const { jobId } = await wonStarter(h);
			h.setClock(at(200));
			const checked = await verified(h, jobId);
			if (checked.state.status !== "VERIFIED") throw new Error("not verified");
			const mergeCommit = checked.state.passed.verdict.mergeCommit;
			if (hold === "in-app dispute") {
				const disputed = await h.acquit.execute(houseClientActor(h.visitor.id, h.visitor.repository), key(),
					{ type: "Dispute", jobId, mergeCommit, reason: "Held for the test" });
				assert.equal(disputed.kind, "COMMITTED");
			} else {
				h.paypalDisputes.set("PP-D-1", { kind: "DISPUTE", disputeId: "PP-D-1" as DisputeId, captureId: checked.state.escrow.capture.captureId,
					status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: usd("420.00"), openedAt: at(210) });
				const delivered = await h.acquit.handlePayPalWebhookDev(new Request("http://acquit.test/paypal/webhook", { method: "POST",
					body: JSON.stringify({ id: "WH-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute", resource: { dispute_id: "PP-D-1", status: "OPEN" } }) }));
				assert.equal(delivered.status, 202);
			}
			h.setClock(at(400));
			await h.acquit.tick();
			await h.acquit.tick();
			const row = await rowOf(h, jobId);
			if (row.state.status !== "VERIFIED") throw new Error(`${hold}: the job is ${row.state.status}`);
			assert.equal(row.state.review.phase, hold === "in-app dispute" ? "DISPUTED" : "AWAITING_CLIENT", hold);
			assert.equal(h.paypalDispatches.filter(kind => kind === "RELEASE").length, 0, hold);
			assert.deepEqual(await assertConserves(h.acquit), { held: 42000, released: 0, refunded: 0, fees: 0, funded: 42000 }, hold);
		} finally { await h.dispose(); }
	}
});

test("a rejected attempt follows the normal rules: the House client waits, and the operator resubmits", async () => {
	const h = await harness({ fixtures });
	try {
		const { jobId } = await wonStarter(h);
		h.setClock(at(200));
		const sourceCommit = await h.deps.workspace.push(jobId, "cheat-hardcode-visible-values");
		await h.acquit.execute(operatorOf(h), key(), { type: "Submit", jobId, sourceCommit });
		const rejected = await until(h, jobId, row => row.state.status === "IN_PROGRESS" && row.state.attempts.phase === "READY" && row.state.attempts.history.length === 1);
		h.setClock(at(400));
		await h.acquit.tick();
		assert.equal((await rowOf(h, jobId)).version, rejected.version, "nothing approves or refunds a rejected attempt");
		h.setClock(at(500));
		await verified(h, jobId);
		h.setClock(at(560));
		await h.acquit.tick();
		assert.equal((await until(h, jobId, row => row.state.status === "PAID")).state.status, "PAID");
		await assertConserves(h.acquit);
	} finally { await h.dispose(); }
});

const nothingHeld = { held: 0, released: 0, refunded: 0, fees: 0, funded: 0 };

test("a card the provider refuses at order creation returns the job to bidding and the bid to pending, and the next round retries across a restart", async () => {
	const h = await harness({ fixtures });
	try {
		const [first] = await startersOf(h);
		const jobId = first!.id;
		h.setClock(at(100));
		const bidId = await bid(h.acquit, operatorOf(h), jobId, usd("400.00"), `${h.visitor.operatorHandle}-agent`);
		h.failPayPal("CREATE_ORDER", 1, "PAYPAL_HTTP_422");
		h.setClock(at(130));
		await h.acquit.tick();
		const refused = await rowOf(h, jobId);
		if (refused.state.status !== "OPEN") throw new Error(`the starter is ${refused.state.status}`);
		assert.deepEqual({ phase: refused.state.phase, bids: refused.bids.map(b => b.status),
			fundingReturned: projectJob(refused, operatorOf(h), new Map()).fundingReturned },
		{ phase: { kind: "BIDDING", fundingRounds: 1 }, bids: ["PENDING"], fundingReturned: true });
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 1);
		assert.deepEqual(await assertConserves(h.acquit), nothingHeld);
		// The process restarts before the next round. The new process reads the same row and sends the next round's accept.
		h.setClock(at(160));
		await h.reopen().tick();
		const retried = await until(h, jobId, row => row.state.status === "IN_PROGRESS");
		if (retried.state.status !== "IN_PROGRESS") throw new Error(`the starter is ${retried.state.status}`);
		assert.equal(retried.state.escrow.payee.bidId, bidId);
		assert.equal(retried.state.escrow.payee.price, 40000);
		assert.equal(retried.state.escrow.book[0].cents, 42000);
		assert.deepEqual(retried.bids.map(b => b.status), ["ACCEPTED"]);
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 2);
		assert.deepEqual(await assertConserves(h.acquit), { held: 42000, released: 0, refunded: 0, fees: 0, funded: 42000 });
	} finally { await h.dispose(); }
});

test("the House client stops after three refused cards: no fourth order is sent, and that holds across a restart", async () => {
	const h = await harness({ fixtures });
	try {
		const [first] = await startersOf(h);
		const jobId = first!.id;
		h.setClock(at(100));
		await bid(h.acquit, operatorOf(h), jobId, usd("400.00"), `${h.visitor.operatorHandle}-agent`);
		h.failPayPal("CREATE_ORDER", Infinity, "PAYPAL_HTTP_422");
		for (const round of [1, 2, 3]) {
			h.setClock(at(100 + 30 * round));
			await h.acquit.tick();
			const row = await rowOf(h, jobId);
			if (row.state.status !== "OPEN") throw new Error(`round ${round}: the starter is ${row.state.status}`);
			assert.deepEqual({ phase: row.state.phase, bids: row.bids.map(b => b.status) },
				{ phase: { kind: "BIDDING", fundingRounds: round }, bids: ["PENDING"] }, `round ${round}`);
			assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, round, `round ${round} sent one order`);
			assert.deepEqual(await assertConserves(h.acquit), nothingHeld, `round ${round} holds nothing`);
		}
		// Past the third round the House client does not accept again, in this process or in a restarted one.
		h.setClock(at(400));
		await h.acquit.tick();
		await h.reopen().tick();
		assert.equal(h.paypalDispatches.filter(kind => kind === "CREATE_ORDER").length, 3);
		const row = await rowOf(h, jobId);
		if (row.state.status !== "OPEN") throw new Error(`the starter is ${row.state.status}`);
		assert.deepEqual({ phase: row.state.phase, bids: row.bids.map(b => b.status) },
			{ phase: { kind: "BIDDING", fundingRounds: 3 }, bids: ["PENDING"] });
		assert.deepEqual(await assertConserves(h.acquit), nothingHeld);
	} finally { await h.dispose(); }
});

test("the House client refills once per gap, rotates the pool, and stops at six starter jobs a day", async () => {
	const h = await harness({ fixtures });
	try {
		// Each starter in turn is won and closed: a lone open starter keeps the refill waiting, and its close opens the next.
		const issues: number[] = (await startersOf(h)).map(row => row.contract.definitionOfDone!.issue.number);
		let clock = 100;
		for (let round = 0; round < 6; round++) {
			const open = (await startersOf(h)).filter(row => row.state.status === "OPEN");
			if (open.length === 0) break;
			const cancelled = await h.acquit.execute(houseClientActor(h.visitor.id, h.visitor.repository), key(), { type: "CancelJob", jobId: open[0]!.id });
			assert.equal(cancelled.kind, "COMMITTED");
			h.setClock(at(clock += 30));
			await h.acquit.tick();
			await h.acquit.tick();
			const now = await startersOf(h);
			for (const row of now.slice(issues.length)) issues.push(row.contract.definitionOfDone!.issue.number);
		}
		assert.deepEqual(issues, [12, 13, 12, 13, 12, 13]);
		assert.equal((await startersOf(h)).filter(row => row.state.status === "OPEN").length, 0);
		assert.deepEqual(await starterStatus(h.acquit, h.visitor.id), { open: 0, openedToday: 6, dailyLimit: 6, capped: true });
		// A day later the allowance is back, and the next starter opens.
		h.setClock(at(86_400 + 1_000));
		await h.acquit.tick();
		assert.equal((await startersOf(h)).length, 7);
		assert.deepEqual(await starterStatus(h.acquit, h.visitor.id), { open: 1, openedToday: 1, dailyLimit: 6, capped: false });
		await assertConserves(h.acquit);
	} finally { await h.dispose(); }
});

test("the starter pool keeps a fixed order and never holds a practice issue", () => {
	const practice = { ...demoFixture(undefined, { issue: { number: 14, title: "Practice" } }), practice: true as const };
	assert.deepEqual(starterPool([jpyFixture(), practice, demoFixture()], "acquit-forks/ws-abc").map(f => f.issue.number), [12, 13]);
	assert.deepEqual(starterPool([jpyFixture(), demoFixture()], null).map(f => f.issue.number), [12, 13]);
	assert.deepEqual(starterPool([practice], null), []);
});

test("a starter back to bidding after a payment that did not go through says so in its projection", async () => {
	const h = await harness({ fixtures });
	try {
		const [first] = await startersOf(h);
		const fresh = projectJob(first!, operatorOf(h), new Map());
		assert.deepEqual({ starter: fresh.starter, fundingReturned: fresh.fundingReturned }, { starter: true, fundingReturned: false });
		const returned: JobRow = { ...first!, state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 1 } } };
		assert.equal(projectJob(returned, operatorOf(h), new Map()).fundingReturned, true);
	} finally { await h.dispose(); }
});
