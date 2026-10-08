// Judge mode's caps: one table holds every limit, one closed code names each refusal, and the counters
// are read from committed rows. A cap check never writes, so it can only refuse a command, never change
// what a command would have done. The visitor caps bind a visitor's own client; the day-wide run cap
// binds the whole deployment, because the free tier belongs to the key, not to one visitor.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit, createDemoVisitor } from "../src/acquit.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { CAPS, capWindowStart, jobCap, modelRunCap, visitorCap } from "../src/caps.ts";
import type { CapCounts } from "../src/caps.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, CommitSha, JobId, MerchantId, OperatorId } from "../src/ids.ts";
import { shiftJobClock } from "../src/job-clock.ts";
import { usd } from "../src/ledger.ts";
import type { UsdCents } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { newVisitorId } from "../src/visitors.ts";
import { exampleContract } from "./hidden-fixture.ts";

const merchant = "sandbox-seller" as MerchantId;
const deployment = "maya-client/invoice-app";
const noon = instant("2026-10-06T12:00:00.000Z");

/** The counters a test starts from: nobody has done anything, and the counted client is a visitor's. */
const counts = (over: Partial<CapCounts>): CapCounts => ({ visitor: true, visitorsFromIp: 0, visitorsToday: 0,
	jobs: 0, budget: 0 as UsdCents, runs: 0, runsToday: 0, ...over });

/** A service whose clock stands still, so a window has an exact edge. */
function serviceAt(path: string) {
	return createAcquit({ databaseUrl: path, hiddenContract: exampleContract, demo: { merchant }, clock: { now: () => noon },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
}

/** The visitor the core minted, and the actor its client session carries. */
async function guestOf(service: ReturnType<typeof serviceAt>, ipKey: string): Promise<{ readonly client: ClientId; readonly actor: Actor }> {
	const created = await createDemoVisitor(service, { id: newVisitorId(), ipKey, repository: null });
	assert.equal(created.kind, "CREATED");
	const client = (created.kind === "CREATED" ? created.visitor.clientHandle : "") as ClientId;
	return { client, actor: { role: "CLIENT", clientId: client, tenant: null } };
}

const jobIdOf = (outcome: CommandOutcome): JobId =>
	outcome.kind === "COMMITTED" && outcome.result.kind === "JOB" ? outcome.result.job.id : "job_missing" as JobId;

test("the cap table is the one place the limits live", () => {
	assert.deepEqual(Object.fromEntries(Object.entries(CAPS).map(([name, spec]) => [name, spec.limit])), {
		VISITORS_IP_DAY: 3, VISITORS_DAY: 50, VISITOR_JOBS: 3, AMOUNT: 100_000, SPEND_DAY: 200_000,
		MODEL_RUNS: 10, MODEL_RUNS_DAY: 1_000 });
});

test("the window is one rolling day, and a cap refuses the act that would pass the limit", () => {
	assert.equal(capWindowStart(noon), "2026-10-05T12:00:00.000Z");
	// Visitors: the address's own window first, then the deployment's day.
	assert.equal(visitorCap(counts({ visitorsFromIp: 2, visitorsToday: 49 })), null);
	assert.equal(visitorCap(counts({ visitorsFromIp: 3 })), "CAP_VISITORS_IP_DAY");
	assert.equal(visitorCap(counts({ visitorsToday: 50 })), "CAP_VISITORS_DAY");
	// Jobs: how many the visitor has, what one may promise, and what it has promised today.
	assert.equal(jobCap(counts({ jobs: 2 }), usd("1000.00")), null);
	assert.equal(jobCap(counts({ jobs: 3 }), usd("1.00")), "CAP_VISITOR_JOBS");
	assert.equal(jobCap(counts({}), usd("1000.01")), "CAP_AMOUNT");
	assert.equal(jobCap(counts({ budget: usd("1500.00") }), usd("500.00")), null);
	assert.equal(jobCap(counts({ budget: usd("1500.00") }), usd("500.01")), "CAP_SPEND_DAY");
	// A client that is not a visitor's is not capped by the visitor caps.
	assert.equal(jobCap(counts({ visitor: false, jobs: 99 }), usd("100000.00")), null);
	// Runs: the visitor's own, then the deployment's free-tier day.
	assert.equal(modelRunCap(counts({ runs: 9, runsToday: 999 })), null);
	assert.equal(modelRunCap(counts({ runs: 10 })), "CAP_MODEL_RUNS");
	assert.equal(modelRunCap(counts({ runsToday: 1_000 })), "CAP_MODEL_RUNS_DAY");
	assert.equal(modelRunCap(counts({ visitor: false, runs: 10 })), null);
	assert.equal(modelRunCap(counts({ visitor: false, runsToday: 1_000 })), "CAP_MODEL_RUNS_DAY");
});

test("the store counts a visitor's own use and the deployment's from committed rows", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-caps-"));
	const path = join(root, "acquit.db");
	const service = serviceAt(path);
	const store = new SqliteStore(path);
	try {
		const guest = await guestOf(service, "ip-a");
		await guestOf(service, "ip-a");
		await guestOf(service, "ip-b");
		const opened = await service.execute(guest.actor, parseRequestKey(randomUUID()),
			{ type: "OpenJob", repository: deployment, issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		const jobId = jobIdOf(opened);
		assert.notEqual(jobId, "job_missing");
		// A row stored by an earlier day: three judged runs, one waiting, and one run that failed outside the window.
		const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
		const job = JSON.parse(row.json) as Record<string, unknown>;
		const state = job.state as Record<string, unknown>;
		const judged = (at: string, ordinal: number) => ({ ordinal, verdict: { result: "REJECTED", runId: `run-${ordinal}`,
			sourceCommit: "a".repeat(40), reasons: ["MISSING_FIX"], reasonsTruncated: 0, at } });
		store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { ...state, attempts: {
			...state.attempts as Record<string, unknown>, runsStarted: 5, phase: "VERIFYING",
			history: [judged("2026-10-06T11:00:00.000Z", 1), judged("2026-10-06T11:30:00.000Z", 2), judged("2026-09-01T00:00:00.000Z", 3)],
			pending: { ordinal: 3, run: 4, runId: "run-4", sourceCommit: "b".repeat(40),
				submittedAt: "2026-10-06T11:50:00.000Z", runEndsAt: "2026-10-06T12:20:00.000Z" },
			failure: { runId: "run-5", sourceCommit: "c".repeat(40), name: "SUBJECT_UNSTARTABLE", detail: "", at: "2026-09-02T00:00:00.000Z" },
		} } }), jobId);
		// The visitor's own use: one job, its budget, and every run it has started. The day-wide count reads
		// only the runs the rows can date inside the window: three judged and waiting, the fourth is older.
		assert.deepEqual(await service.capCounts({ clientId: guest.client, ipKey: "ip-a" }),
			{ visitor: true, visitorsFromIp: 2, visitorsToday: 3, jobs: 1, budget: 40_000, runs: 5, runsToday: 3 });
		// The seeded client is not a visitor's, and nobody else's job is counted for this client.
		assert.equal((await service.capCounts({ clientId: "maya-client" as ClientId, ipKey: null })).visitor, false);
		assert.equal((await service.capCounts({ clientId: null, ipKey: "ip-b" })).jobs, 0);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

/** Puts a stored row into work under one operator's escrow: the only state a Submit reads. */
function inWorkRow(store: SqliteStore, jobId: JobId, operator: string): void {
	const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
	const job = JSON.parse(row.json) as Record<string, unknown>;
	store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status: "IN_PROGRESS",
		escrow: { payee: { bidId: "bid_escrow", operator, payee: merchant, agent: "ts-bugfixer", price: 40000, eta: 48 },
			quote: {}, capture: { orderId: "ORDER-CAPS-1", captureId: "CAPTURE-CAPS-1" }, book: [], cutoffAt: "2026-11-01T00:00:00.000Z" },
		attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } }), jobId);
}

test("a run stays counted after its job settles and after the job's clock moves", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-caps-"));
	const path = join(root, "acquit.db");
	const service = serviceAt(path);
	const store = new SqliteStore(path);
	try {
		const created = await createDemoVisitor(service, { id: newVisitorId(), ipKey: "ip-a", repository: null });
		assert.equal(created.kind, "CREATED");
		const visitor = created.visitor;
		const client: Actor = { role: "CLIENT", clientId: visitor.clientHandle as ClientId, tenant: visitor.id };
		const operator: Actor = { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id };
		const opened = await service.execute(client, parseRequestKey(randomUUID()), { type: "OpenJob", repository: deployment,
			issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		const jobId = jobIdOf(opened);
		inWorkRow(store, jobId, visitor.operatorHandle);
		const submitted = await service.execute(operator, parseRequestKey(randomUUID()),
			{ type: "Submit", jobId, sourceCommit: "d".repeat(40) as CommitSha });
		assert.equal(submitted.kind, "COMMITTED");
		const counts = () => service.capCounts({ clientId: visitor.clientHandle as ClientId, ipKey: null });
		assert.equal((await counts()).runs, 1);
		// The job's own clock moves two days. A run is a fact of the deployment's day, not of this row's.
		assert.notEqual(shiftJobClock(store.db, jobId, 2 * 86_400_000), null);
		assert.equal((await counts()).runsToday, 1);
		// A settled row carries no attempt fields at all; the run it spent is still spent.
		const asState = (status: string): void => {
			const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
			const job = JSON.parse(row.json) as Record<string, unknown>;
			store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status } }), jobId);
		};
		asState("PAID"); assert.equal((await counts()).runs, 1);
		asState("REFUNDED"); assert.equal((await counts()).runs, 1);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("a capped visitor's job and run are refused by code", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-caps-"));
	const path = join(root, "acquit.db");
	const service = serviceAt(path);
	const store = new SqliteStore(path);
	/** Puts a stored row into work with the runs it has already started: the only state a Submit reads. */
	const inWork = (jobId: JobId, runsStarted: number): void => {
		const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
		const job = JSON.parse(row.json) as Record<string, unknown>;
		store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status: "IN_PROGRESS",
			escrow: { payee: { operator: "devon-ops", agent: "house-ts-fixer" } },
			attempts: { phase: "READY", history: [], runsStarted, failure: null } } }), jobId);
	};
	const submit = (jobId: JobId): UserCommand => ({ type: "Submit", jobId, sourceCommit: "d".repeat(40) as CommitSha });
	const operator: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
	try {
		const guest = await guestOf(service, "ip-a");
		const open = (budget: UsdCents): UserCommand => ({ type: "OpenJob", repository: deployment, issueNumber: 12,
			budget, deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		// A budget over the ceiling is refused before anything is written.
		assert.deepEqual(await service.execute(guest.actor, parseRequestKey(randomUUID()), open(usd("1000.01"))),
			{ kind: "DENIED", reason: "CAP_AMOUNT" });
		const first = await service.execute(guest.actor, parseRequestKey(randomUUID()), open(usd("400.00")));
		assert.equal(first.kind, "COMMITTED");
		const jobId = jobIdOf(first);
		for (const budget of [usd("400.00"), usd("400.00")]) {
			assert.equal((await service.execute(guest.actor, parseRequestKey(randomUUID()), open(budget))).kind, "COMMITTED");
		}
		// Three jobs is the visitor's whole allowance, whatever the budgets were.
		assert.deepEqual(await service.execute(guest.actor, parseRequestKey(randomUUID()), open(usd("1.00"))),
			{ kind: "DENIED", reason: "CAP_VISITOR_JOBS" });
		// The visitor's operator submits; the run the Submit would start is the owning visitor's.
		inWork(jobId, 10);
		assert.deepEqual(await service.execute(operator, parseRequestKey(randomUUID()), submit(jobId)),
			{ kind: "DENIED", reason: "CAP_MODEL_RUNS" });
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
