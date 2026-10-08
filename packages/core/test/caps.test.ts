// Judge mode's caps: one table holds every limit and the reservation kind that spends it, one closed
// code names each refusal, and the counters are read from cap_reservations, which is written only in
// the transaction that commits the act it pays for. A refusal writes nothing, so it can only refuse a
// command, never change what a command would have done. A reservation is never released: a settled
// job and a shifted job clock cannot give back what a visitor spent.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit, createDemoVisitor } from "../src/acquit.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { CAPS, capUsage, capWindowStart, reservationRefusal } from "../src/caps.ts";
import type { CapUsage, Reservation } from "../src/caps.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, CommitSha, JobId, MerchantId, OperatorId, VisitorId } from "../src/ids.ts";
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

/** The counters a test starts from: nobody has done anything. */
const usage = (over: Partial<CapUsage>): CapUsage => ({ visitorsFromIp: 0, visitorsToday: 0, jobs: 0,
	budget: 0 as UsdCents, runs: 0, runsToday: 0, ...over });

/** A service whose clock stands still, so a window has an exact edge. */
function serviceAt(path: string) {
	return createAcquit({ databaseUrl: path, hiddenContract: exampleContract, demo: { merchant }, clock: { now: () => noon },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
}

/** The visitor the core minted, and the two actors its sessions carry. */
async function guestOf(service: ReturnType<typeof serviceAt>, ipKey: string) {
	const created = await createDemoVisitor(service, { id: newVisitorId(), ipKey, repository: null });
	assert.equal(created.kind, "CREATED");
	if (created.kind !== "CREATED") throw new Error("The caps refused the fixture's visitor");
	const visitor = created.visitor;
	return { visitor, client: visitor.clientHandle as ClientId,
		actor: { role: "CLIENT", clientId: visitor.clientHandle as ClientId, tenant: visitor.id } as Actor,
		operator: { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id } as Actor };
}

const jobIdOf = (outcome: CommandOutcome): JobId =>
	outcome.kind === "COMMITTED" && outcome.result.kind === "JOB" ? outcome.result.job.id : "job_missing" as JobId;

test("the cap table is the one place the limits live", () => {
	assert.deepEqual(Object.fromEntries(Object.entries(CAPS).map(([name, spec]) => [name, spec.limit])), {
		VISITORS_IP_DAY: 3, VISITORS_DAY: 50, VISITOR_JOBS: 3, AMOUNT: 100_000, SPEND_DAY: 200_000,
		MODEL_RUNS: 10, MODEL_RUNS_DAY: 1_000 });
});

test("the window is one rolling day, and a reservation is refused by the cap it would pass", () => {
	assert.equal(capWindowStart(noon), "2026-10-05T12:00:00.000Z");
	const visitor = (over: Partial<Reservation>): Reservation =>
		({ kind: "VISITOR", scope: "ip-a", ref: "v_1", cents: 0 as UsdCents, at: noon, ...over });
	const job = (over: Partial<Reservation>): Reservation =>
		({ kind: "JOB", scope: "v_1", ref: "job_1", cents: usd("400.00"), at: noon, ...over });
	const run = (over: Partial<Reservation>): Reservation =>
		({ kind: "RUN", scope: "v_1", ref: "job_1:verify:1", cents: 0 as UsdCents, at: noon, ...over });
	// Visitors: the address's own window first, then the deployment's day.
	assert.equal(reservationRefusal(visitor({}), usage({ visitorsFromIp: 2, visitorsToday: 49 })), null);
	assert.equal(reservationRefusal(visitor({}), usage({ visitorsFromIp: 3 })), "CAP_VISITORS_IP_DAY");
	assert.equal(reservationRefusal(visitor({}), usage({ visitorsToday: 50 })), "CAP_VISITORS_DAY");
	// Jobs: how many the visitor has, what one may promise, and what it has promised today.
	assert.equal(reservationRefusal(job({ cents: usd("1000.00") }), usage({ jobs: 2 })), null);
	assert.equal(reservationRefusal(job({ cents: usd("1.00") }), usage({ jobs: 3 })), "CAP_VISITOR_JOBS");
	assert.equal(reservationRefusal(job({ cents: usd("1000.01") }), usage({})), "CAP_AMOUNT");
	assert.equal(reservationRefusal(job({ cents: usd("500.00") }), usage({ budget: usd("1500.00") })), null);
	assert.equal(reservationRefusal(job({ cents: usd("500.01") }), usage({ budget: usd("1500.00") })), "CAP_SPEND_DAY");
	// Runs: the visitor's own, then the deployment's free-tier day.
	assert.equal(reservationRefusal(run({}), usage({ runs: 9, runsToday: 999 })), null);
	assert.equal(reservationRefusal(run({}), usage({ runs: 10 })), "CAP_MODEL_RUNS");
	assert.equal(reservationRefusal(run({}), usage({ runsToday: 1_000 })), "CAP_MODEL_RUNS_DAY");
	// The kinds do not borrow each other's counters: a visitor reservation never reads the run caps.
	assert.equal(reservationRefusal(visitor({}), usage({ runs: 10, runsToday: 1_000 })), null);
});

test("the counters read the reservation table by wall clock and by scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-caps-"));
	const path = join(root, "acquit.db");
	const store = new SqliteStore(path);
	/** One reservation row as a committed act leaves it. The table is append-only; this is the fixture. */
	const reserved = (at: string, kind: string, scope: string, ref: string, cents = 0): void => {
		store.db.prepare("INSERT INTO cap_reservations VALUES (?, ?, ?, ?, ?)").run(kind, scope, ref, cents, at);
	};
	try {
		reserved("2026-10-06T11:00:00.000Z", "VISITOR", "ip-a", "v_1");
		reserved("2026-10-06T10:00:00.000Z", "VISITOR", "ip-a", "v_2");
		reserved("2026-10-04T11:00:00.000Z", "VISITOR", "ip-a", "v_old");
		reserved("2026-10-06T11:30:00.000Z", "JOB", "v_1", "job_1", 40_000);
		reserved("2026-10-06T11:45:00.000Z", "JOB", "v_2", "job_2", 25_000);
		reserved("2026-10-06T11:50:00.000Z", "RUN", "v_1", "job_1:verify:1");
		// One visitor's own day: its jobs and its runs. The visitor row older than the window is gone.
		assert.deepEqual(capUsage(store.db, { scope: "v_1", since: capWindowStart(noon) }),
			{ visitorsFromIp: 0, visitorsToday: 2, jobs: 1, budget: 40_000, runs: 1, runsToday: 1 });
		// One address's own day: its visitors. The other visitor's job and run are not its own.
		assert.deepEqual(capUsage(store.db, { scope: "ip-a", since: capWindowStart(noon) }),
			{ visitorsFromIp: 2, visitorsToday: 2, jobs: 0, budget: 0, runs: 0, runsToday: 1 });
	} finally { store.close(); await rm(root, { recursive: true, force: true }); }
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
		const guest = await guestOf(service, "ip-a");
		const opened = await service.execute(guest.actor, parseRequestKey(randomUUID()), { type: "OpenJob", repository: deployment,
			issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		const jobId = jobIdOf(opened);
		inWorkRow(store, jobId, guest.visitor.operatorHandle);
		const submitted = await service.execute(guest.operator, parseRequestKey(randomUUID()),
			{ type: "Submit", jobId, sourceCommit: "d".repeat(40) as CommitSha });
		assert.equal(submitted.kind, "COMMITTED");
		const counted = () => capUsage(store.db, { scope: guest.visitor.id as string, since: capWindowStart(noon) });
		assert.equal(counted().runs, 1);
		// The job's own clock moves two days. A run is a fact of the deployment's day, not of this row's.
		assert.notEqual(shiftJobClock(store.db, jobId, 2 * 86_400_000), null);
		assert.equal(counted().runs, 1);
		assert.equal(counted().runsToday, 1);
		// A settled row carries no attempt fields at all; the run it spent is still spent.
		const asState = (status: string): void => {
			const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
			const job = JSON.parse(row.json) as Record<string, unknown>;
			store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status } }), jobId);
		};
		asState("PAID"); assert.equal(counted().runs, 1);
		asState("REFUNDED"); assert.equal(counted().runs, 1);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("a capped visitor's job and run are refused by code, and a tenant-less client is not capped", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-caps-"));
	const path = join(root, "acquit.db");
	const service = serviceAt(path);
	const store = new SqliteStore(path);
	/** Puts a stored row into work with the runs it has already started: the only state a Submit reads. */
	const inWork = (jobId: JobId, runsStarted: number, operator: string): void => {
		const row = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string };
		const job = JSON.parse(row.json) as Record<string, unknown>;
		store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status: "IN_PROGRESS",
			escrow: { payee: { bidId: "bid_escrow", operator, payee: merchant, agent: "house-ts-fixer", price: 40000, eta: 48 },
				quote: {}, capture: { orderId: "ORDER-CAPS-2", captureId: "CAPTURE-CAPS-2" }, book: [], cutoffAt: "2026-11-01T00:00:00.000Z" },
			attempts: { phase: "READY", history: [], runsStarted, failure: null } } }), jobId);
	};
	const submit = (jobId: JobId): UserCommand => ({ type: "Submit", jobId, sourceCommit: "d".repeat(40) as CommitSha });
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
		// The visitor's operator submits; the run the Submit would start is the owning visitor's. The ten
		// runs it has already spent are committed reservations, which is the only place a spend lives: the
		// row's own runsStarted counter is not what the cap reads.
		inWork(jobId, 10, guest.visitor.operatorHandle);
		for (let run = 1; run <= 10; run++) {
			store.db.prepare("INSERT INTO cap_reservations VALUES (?, ?, ?, ?, ?)")
				.run("RUN", guest.visitor.id, `${jobId}:verify:${run}`, 0, noon);
		}
		assert.deepEqual(await service.execute(guest.operator, parseRequestKey(randomUUID()), submit(jobId)),
			{ kind: "DENIED", reason: "CAP_MODEL_RUNS" });
		// The deployment's own client has no tenant, so it opens jobs outside the visitor caps. Its jobs are
		// counted in no visitor's scope: the same act that a visitor's fourth job is refused for commits here.
		const own: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
		assert.equal((await service.execute(own, parseRequestKey(randomUUID()), open(usd("1000.00")))).kind, "COMMITTED");
		assert.deepEqual(capUsage(store.db, { scope: guest.visitor.id as string, since: capWindowStart(noon) }),
			{ visitorsFromIp: 0, visitorsToday: 1, jobs: 3, budget: 120_000, runs: 10, runsToday: 10 });
		assert.equal(capUsage(store.db, { scope: "maya-client", since: capWindowStart(noon) }).jobs, 0);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
