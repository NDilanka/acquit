// The signed-out floor and agent view are served from a short cache, and one pass over the rows gives every agent its
// record. These tests run against a fresh in-memory store: no HTTP server, no PayPal call, no clock other than the one
// each test passes in.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CODE_VERTICAL } from "../../../packages/core/src/code-manifest.ts";
import { GRADE_PER_REJECTED, GRADE_PER_VERIFIED, GRADE_START, recordOf } from "../../../packages/core/src/exam.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import type { Acquittal, Agent } from "../../../packages/core/src/operator.ts";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { agentListJson, agentViewJson, floorJson, gateReport, PUBLIC_READ_MAX_KEYS, PUBLIC_READ_TTL_MS, publicAgentViewJson,
	publicFloorJson, publicReadComputeCount, readAgentRow, recordsByAgent, resetPublicReadCache, startExam } from "../src/specialists.ts";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const NOW = instant("2026-11-10T12:00:00.000Z");
const SHA = "c".repeat(40);
const DEADLINE = "2026-11-13T12:00:00.000Z";
const OPENED = "2026-11-10T09:00:00.000Z";
const CAPTURED = "2026-11-10T10:00:00.000Z";
const PASSED = "2026-11-10T10:30:00.000Z";
const REJECTED = "2026-11-10T11:00:00.000Z";
const ACQUITTED = "2026-11-10T09:30:00.000Z";
const SEEDED = "2026-11-01T00:00:00.000Z";
const ACQUITTAL_A: Acquittal = { examId: "exam-a", at: instant(ACQUITTED), simulated: true };
const ACQUITTAL_B: Acquittal = { examId: "seed", at: instant(SEEDED) };

beforeEach(() => { resetPublicReadCache(); });

function agentFixture(id: string, owner: string, acquittal: Acquittal | null): Agent {
	return { id, owner, name: id, runner: "claude-code", promptDigest: "e".repeat(64), tools: [], task: CODE_VERTICAL,
		acquittal, sample: null } as unknown as Agent;
}

function lockedBid(agent: string, bidId: string, price: number) {
	return { bidId, operator: "devon-ops", payee: "MERCHANT-PRIVATE-7", agent, price, eta: 48 };
}

function verdict(result: "VERIFIED" | "REJECTED", runId: string, at: string) {
	return result === "VERIFIED"
		? { result, runId, sourceCommit: SHA, mergeCommit: SHA, pullRequest: 9, frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 5 }, at }
		: { result, runId, sourceCommit: SHA, reasonsTruncated: 0, reasons: [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden-test"] }], at };
}

function jobRow(id: string, state: Record<string, unknown>, bids: unknown[] = []): JobRow {
	return { id, version: 1, client: "maya-client", title: id, openedAt: OPENED, contract: { budget: 40000, deliveryEndsAt: DEADLINE },
		bids, state } as unknown as JobRow;
}

/** One job per status. Agent A holds a PAID, a REFUNDED and an IN_PROGRESS job; agent B a VERIFIED job; agent C a PAID job and no acquittal. */
function rowsFixture(): JobRow[] {
	return [
		jobRow("job-open", { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } }, [{ id: "bid-open", agent: "agent-b", price: 40000, status: "ACCEPTED" }]),
		jobRow("job-closed", { status: "CLOSED", reason: "withdrawn" }),
		jobRow("job-in-progress", { status: "IN_PROGRESS",
			escrow: { payee: lockedBid("agent-a", "bid-ip", 40000), capture: { orderId: "ORDER-IP", captureId: "CAP-IP", payee: "MERCHANT-PRIVATE-7" },
				book: [{ kind: "HELD", cents: 40000, at: CAPTURED }] },
			attempts: { phase: "RUNNING", history: [{ ordinal: 1, verdict: verdict("REJECTED", "run-ip-1", REJECTED) }], runsStarted: 1, failure: null } }),
		jobRow("job-verified", { status: "VERIFIED",
			escrow: { payee: lockedBid("agent-b", "bid-v", 40000), capture: { orderId: "ORDER-V", captureId: "CAP-V", payee: "MERCHANT-PRIVATE-7" },
				book: [{ kind: "HELD", cents: 40000, at: CAPTURED }] },
			history: [{ ordinal: 1, verdict: verdict("VERIFIED", "run-v-1", PASSED) }],
			review: { phase: "AWAITING_CLIENT", endsAt: DEADLINE } }),
		jobRow("job-paid", { status: "PAID", payee: lockedBid("agent-a", "bid-paid", 36000),
			book: [{ kind: "HELD", cents: 36000, at: CAPTURED }, { kind: "RELEASED", cents: 36000, at: PASSED }],
			release: { payoutItemId: "PAYOUT-P", captureId: "CAP-P", paid: 36000, at: PASSED }, releaseAuthority: "CLIENT_APPROVAL",
			history: [{ ordinal: 1, verdict: verdict("VERIFIED", "run-paid-1", PASSED) }],
			merge: { phase: "MERGED", at: PASSED, sha: SHA }, treasury: [] }),
		jobRow("job-refunded", { status: "REFUNDED", payee: lockedBid("agent-a", "bid-ref", 40000),
			book: [{ kind: "HELD", cents: 40000, at: CAPTURED }, { kind: "REFUND", cents: 40000, at: REJECTED }],
			refund: { refundId: "REFUND-R", captureId: "CAP-R", refunded: 40000, retainedProcessorFee: 0, at: REJECTED },
			history: [{ ordinal: 1, verdict: verdict("VERIFIED", "run-ref-1", PASSED) }, { ordinal: 2, verdict: verdict("REJECTED", "run-ref-2", REJECTED) }],
			treasury: [] }),
		jobRow("job-agent-c", { status: "PAID", payee: lockedBid("agent-c", "bid-c", 36000),
			book: [{ kind: "HELD", cents: 36000, at: CAPTURED }, { kind: "RELEASED", cents: 36000, at: PASSED }],
			release: { payoutItemId: "PAYOUT-C", captureId: "CAP-C", paid: 36000, at: PASSED }, releaseAuthority: "CLIENT_APPROVAL",
			history: [{ ordinal: 1, verdict: verdict("VERIFIED", "run-c-1", PASSED) }],
			merge: { phase: "MERGED", at: PASSED, sha: SHA }, treasury: [] }),
	];
}

/** Agents A and B are acquitted, C is not, and IDLE holds no rows. The rows are inserted before any read. */
function storeWithFixture(): SqliteStore {
	const store = new SqliteStore(":memory:");
	const insertAgent = (agent: Agent) => store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
	insertAgent(agentFixture("agent-a", "owner-one", ACQUITTAL_A));
	insertAgent(agentFixture("agent-b", "owner-two", ACQUITTAL_B));
	insertAgent(agentFixture("agent-c", "owner-two", null));
	insertAgent(agentFixture("agent-idle", "owner-two", null));
	for (const row of rowsFixture()) store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run(row.id, row.version, JSON.stringify(row));
	return store;
}

test("one pass over the rows gives every agent the record recordOf gives it, for every job status", () => {
	const rows = rowsFixture();
	const grouped = recordsByAgent(rows);
	for (const id of ["agent-a", "agent-b", "agent-c", "agent-idle"]) {
		assert.deepEqual(grouped.get(id) ?? recordOf(id, []), recordOf(id, rows), `record of ${id}`);
	}
	assert.deepEqual(recordOf("agent-a", rows), { jobsTaken: 3, verified: 1, rejected: 2, earnedCents: 36000 });
	assert.deepEqual(recordOf("agent-b", rows), { jobsTaken: 1, verified: 1, rejected: 0, earnedCents: 0 });
	assert.equal(grouped.has("agent-idle"), false, "an agent with no rows has no bucket");
});

test("the floor, the agent views and the signed-in agent list keep their numbers", () => {
	const store = storeWithFixture();
	const agentA = readAgentRow(store.db, "agent-a")!;
	const agentC = readAgentRow(store.db, "agent-c")!;
	const floor = floorJson(store.db, T0).specialists;
	assert.deepEqual(floor, [
		{ agentId: "agent-b", name: "agent-b", task: CODE_VERTICAL, grade: GRADE_START + GRADE_PER_VERIFIED,
			record: { jobsTaken: 1, verified: 1, rejected: 0, earnedCents: 0 }, earnedCents: 0, seeded: true, simulated: false,
			gate: gateReport(readAgentRow(store.db, "agent-b")!) },
		{ agentId: "agent-a", name: "agent-a", task: CODE_VERTICAL, grade: GRADE_START + GRADE_PER_VERIFIED - 2 * GRADE_PER_REJECTED,
			record: { jobsTaken: 3, verified: 1, rejected: 2, earnedCents: 36000 }, earnedCents: 36000, seeded: false, simulated: true,
			gate: gateReport(agentA) },
	]);
	assert.deepEqual(agentViewJson(store.db, agentA, T0), {
		id: "agent-a", name: "agent-a", task: CODE_VERTICAL, runner: "claude-code", owner: { handle: "owner-one" },
		acquittal: { examId: "exam-a", at: ACQUITTED, seeded: false, simulated: true }, acquittedAt: ACQUITTED,
		gate: gateReport(agentA), grade: GRADE_START + GRADE_PER_VERIFIED - 2 * GRADE_PER_REJECTED,
		record: { jobsTaken: 3, verified: 1, rejected: 2, earnedCents: 36000 },
	});
	assert.deepEqual(agentViewJson(store.db, agentC, T0), {
		id: "agent-c", name: "agent-c", task: CODE_VERTICAL, runner: "claude-code", owner: { handle: "owner-two" },
		acquittal: null, acquittedAt: null, gate: gateReport(agentC), grade: null,
		record: { jobsTaken: 1, verified: 1, rejected: 0, earnedCents: 36000 },
	});
	const owned = agentListJson(store.db, agentA);
	assert.equal(owned.grade, GRADE_START + GRADE_PER_VERIFIED - 2 * GRADE_PER_REJECTED);
	assert.equal(owned.standingOrders, null);
});

test("a burst of signed-out reads computes each public body once and returns one body", () => {
	const store = storeWithFixture();
	const floors = Array.from({ length: 50 }, (_, i) => publicFloorJson(store.db, T0 + i));
	assert.equal(publicReadComputeCount(), 1, "fifty floor reads inside the TTL compute once");
	for (const body of floors) assert.equal(body, floors[0]);
	const agentA = readAgentRow(store.db, "agent-a")!;
	const views = Array.from({ length: 20 }, (_, i) => publicAgentViewJson(store.db, agentA, T0 + i));
	assert.equal(publicReadComputeCount(), 2, "twenty views of one agent add one computation");
	for (const body of views) assert.equal(body, views[0]);
	publicAgentViewJson(store.db, readAgentRow(store.db, "agent-b")!, T0);
	assert.equal(publicReadComputeCount(), 3, "a second agent is a second key");
});

test("a cached public read is served inside the TTL and recomputed at it", () => {
	const store = storeWithFixture();
	assert.equal(publicFloorJson(store.db, T0).specialists.length, 2);
	assert.equal(publicReadComputeCount(), 1);
	// An acquittal written without the exam path. The cache keeps the old floor until the TTL passes.
	const late = agentFixture("agent-c", "owner-two", { examId: "exam-late", at: instant(ACQUITTED), simulated: true });
	store.db.prepare("UPDATE agents SET json = ? WHERE id = ?").run(JSON.stringify(late), "agent-c");
	assert.equal(publicFloorJson(store.db, T0 + PUBLIC_READ_TTL_MS - 1).specialists.length, 2, "inside the TTL the floor is served from cache");
	assert.equal(publicReadComputeCount(), 1);
	assert.equal(publicFloorJson(store.db, T0 + PUBLIC_READ_TTL_MS).specialists.length, 3, "at the TTL the floor is recomputed");
	assert.equal(publicReadComputeCount(), 2);
});

test("an acquittal write clears the public reads at once, so an owner's new pass shows without waiting for the TTL", () => {
	const store = new SqliteStore(":memory:");
	const candidate = agentFixture("stale-coder", "devon-ops", null);
	store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(candidate.id, candidate.owner, JSON.stringify(candidate));
	assert.deepEqual(publicFloorJson(store.db, T0).specialists, []);
	const started = startExam(store.db, candidate, "exam_cache", NOW);
	assert.equal(started.ok, true);
	const floor = publicFloorJson(store.db, T0 + 1000).specialists;
	assert.equal(floor.length, 1);
	assert.equal(floor[0]!.agentId, "stale-coder");
	assert.equal(floor[0]!.simulated, true);
});

test("the cache holds at most PUBLIC_READ_MAX_KEYS keys and drops the oldest first", () => {
	const store = new SqliteStore(":memory:");
	const agents = Array.from({ length: PUBLIC_READ_MAX_KEYS + 1 }, (_, i) => agentFixture(`bulk-${i}`, "owner-bulk", null));
	for (const agent of agents) store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
	for (const agent of agents) publicAgentViewJson(store.db, agent, T0);
	assert.equal(publicReadComputeCount(), PUBLIC_READ_MAX_KEYS + 1);
	publicAgentViewJson(store.db, agents[PUBLIC_READ_MAX_KEYS]!, T0);
	assert.equal(publicReadComputeCount(), PUBLIC_READ_MAX_KEYS + 1, "the newest key is still cached");
	publicAgentViewJson(store.db, agents[0]!, T0);
	assert.equal(publicReadComputeCount(), PUBLIC_READ_MAX_KEYS + 2, "the oldest key was dropped and is recomputed");
});
