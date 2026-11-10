// The hosted sample runner over fakes. The runner's decisions and run records are real. The command edge, the House
// client's accept and approve, the verifier's verdict, and the fork push are simulated here, so the test needs no
// Docker, network, PayPal or git checkout. The House client and the real verifier are covered by their own tests.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Actor, CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { CommitSha, OperatorId, RequestKey, VisitorId } from "../../../packages/core/src/ids.ts";
import { hours } from "../../../packages/core/src/ids.ts";
import { HOUSE_CLIENT_ID } from "../../../packages/core/src/house-client.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import type { ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import { SAMPLE_RUNS_PER_DAY, type SampleOrders } from "../../../packages/core/src/sample-runner.ts";
import { activityJson, activityLimit, ACTIVITY_LABELS } from "../src/sample-activity.ts";
import { createSampleRunner, sampleRunJobIds, type SampleRunnerPorts, type SampleRunnerVisitor } from "../src/sample-runner.ts";

const OPERATOR = "op_sample_visitor";
const VISITOR: SampleRunnerVisitor = { id: "v_sample" as VisitorId, operatorHandle: OPERATOR, repository: "acquit-forks/invoice-app-sample" };
const AGENT = { id: "code-sample-visitor", task: "code", sample: true, acquitted: true };
const ORDERS: SampleOrders = { autopilot: true, runsOn: "acquit", priceFloorCents: 1_000 };
const JOB_ID = "job_starter_1";
const BUDGET_CENTS = 5_000;
const PAID_CENTS = 4_750;
const START = Date.parse("2026-11-11T12:00:00.000Z");

type PlaceBid = Extract<UserCommand, { type: "PlaceBid" }>;

/** A stored job row, carrying the fields the runner and the activity read. */
function storedRow(id: string, fields: { client: string; tenant: string | null; state: object; bids: object[] }): JobRow {
	return {
		id, version: 1, client: fields.client, tenant: fields.tenant, title: `Job ${id}`, openedAt: "2026-11-11T10:00:00.000Z",
		contract: { budget: BUDGET_CENTS, deliveryEndsAt: "2026-11-13T12:00:00.000Z", definitionOfDone: null },
		bids: fields.bids, state: fields.state,
	} as unknown as JobRow;
}

const openState = { status: "OPEN", phase: { kind: "BIDDING" } };

function heldState(at: string, phase: "READY" | "VERIFYING" = "READY") {
	return {
		status: "IN_PROGRESS",
		escrow: { payee: { operator: OPERATOR }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at }] },
		attempts: { phase, history: [], runsStarted: 1, failure: null },
	};
}

/** The fake world: one starter job on the House client, the command edge, the House client's steps, and the push. */
function fakeWorld(pushError: Error | null = null) {
	let at = START;
	let failure = pushError;
	let rows: JobRow[] = [storedRow(JOB_ID, { client: HOUSE_CLIENT_ID, tenant: VISITOR.id, state: openState, bids: [] })];
	let lastRecord: object = {};
	const actors: Actor[] = [];
	const commands: UserCommand[] = [];
	const pushes: CommitSha[] = [];
	const logs: string[] = [];

	const now = () => new Date(at).toISOString();
	const jobRow = (): JobRow => {
		const row = rows.find(entry => entry.id === JOB_ID);
		if (row === undefined) throw new Error("the fake job is missing");
		return row;
	};
	const patch = (fields: Record<string, unknown>) => {
		rows = rows.map(row => (row.id === JOB_ID ? ({ ...row, ...fields } as unknown as JobRow) : row));
	};

	const execute = async (actor: Actor, _key: RequestKey, command: UserCommand): Promise<CommandOutcome> => {
		actors.push(actor);
		commands.push(command);
		if (command.type === "PlaceBid") {
			const bid = { id: `bid_${commands.length}`, operator: OPERATOR, agent: command.agent, price: command.price,
				eta: command.eta, pitch: command.pitch, placedAt: now(), status: "PENDING" };
			patch({ bids: [bid] });
			return { kind: "COMMITTED", result: { kind: "BID", job: { id: JOB_ID }, bid, creditsLeft: 4 } } as unknown as CommandOutcome;
		}
		if (command.type === "Submit") {
			patch({ state: heldState(now(), "VERIFYING") });
			return { kind: "COMMITTED", result: { kind: "JOB", job: { id: JOB_ID } } } as unknown as CommandOutcome;
		}
		throw new Error(`the fake has no ${command.type}`);
	};

	const workspace: ScenarioWorkspace = {
		push: async () => {
			if (failure !== null) throw failure;
			const commit = String(pushes.length + 1).padStart(40, "0") as CommitSha;
			pushes.push(commit);
			return commit;
		},
	};

	return {
		actors, commands, pushes, logs, now, rows: () => rows, jobRow, execute, workspace,
		advance: (ms: number) => { at += ms; },
		log: (line: string) => { logs.push(line); },
		/** The House client accepts the bid and funds the job. */
		houseAccepts: () => patch({ bids: jobRow().bids.map(bid => ({ ...bid, status: "ACCEPTED" })), state: heldState(now()) }),
		/** The real verifier passes the commit. */
		verifierPasses: (commit: CommitSha) => {
			lastRecord = { ordinal: 1, verdict: { result: "VERIFIED", runId: "run_sample_1", sourceCommit: commit,
				mergeCommit: "f".repeat(40), frozen: { passed: 3, expected: 3 }, hidden: { passed: 4, expected: 4 },
				reportDigest: "0".repeat(64), at: now() } };
			patch({ state: { status: "VERIFIED", escrow: { payee: { operator: OPERATOR }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at: now() }] },
				history: [lastRecord], passed: true, review: { phase: "AWAITING_CLIENT", endsAt: new Date(at + 60_000).toISOString() }, runsStarted: 1 } });
		},
		/** The House client approves, and the payout is captured. */
		houseApproves: () => patch({ state: { status: "PAID", payee: { operator: OPERATOR }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at: now() }],
			history: [lastRecord], release: { payoutItemId: "PAYOUT_SAMPLE_1", captureId: "CAPTURE_SAMPLE_1", paid: PAID_CENTS, at: now() },
			releaseAuthority: "CLIENT_APPROVAL", merge: null, treasury: null } }),
	};
}

type World = ReturnType<typeof fakeWorld>;

function portsOf(db: DatabaseSync, world: World, overrides: Partial<SampleRunnerPorts> = {}): SampleRunnerPorts {
	return {
		db, enabled: true, now: world.now, log: world.log,
		visitors: () => [VISITOR],
		jobs: world.rows,
		agentsOf: handle => (handle === OPERATOR ? [AGENT] : []),
		ordersOf: () => ORDERS,
		fixtureMatched: () => true,
		execute: world.execute,
		workspace: world.workspace,
		...overrides,
	};
}

function recordOf(db: DatabaseSync) {
	return db.prepare("SELECT phase, commit_sha, outcome, failures FROM sample_runner_runs WHERE job_id = ?").get(JOB_ID) as
		{ readonly phase: string; readonly commit_sha: string | null; readonly outcome: string | null; readonly failures: number } | undefined;
}

function placeBids(world: World): PlaceBid[] {
	return world.commands.filter((command): command is PlaceBid => command.type === "PlaceBid");
}

function activityFor(db: DatabaseSync, world: World, runner: ReturnType<typeof createSampleRunner>) {
	return activityJson({
		operatorId: OPERATOR as OperatorId, limit: 20, rows: world.rows(), sampleJobIds: sampleRunJobIds(db), enabled: true,
		runner: runner.statusOf(VISITOR, world.rows()),
	});
}

function stateList(db: DatabaseSync, world: World, runner: ReturnType<typeof createSampleRunner>): string[] {
	return activityFor(db, world, runner).activity.map(item => item.state);
}

test("a visitor's sample agent bids, is accepted, pushes, is verified and is paid, and the activity shows each step", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world));

	await runner.kick();
	assert.deepEqual(world.commands.map(command => command.type), ["PlaceBid"]);
	assert.deepEqual(world.actors[0], { role: "OPERATOR", operatorId: OPERATOR, tenant: VISITOR.id },
		"the bid is the visitor's own operator's, inside the visitor's tenant");
	const [bid] = placeBids(world);
	assert.equal(bid?.price, ORDERS.priceFloorCents);
	assert.deepEqual(bid?.eta, hours(48));
	assert.equal(bid?.agent, AGENT.id);
	assert.deepEqual([...sampleRunJobIds(db)], [JOB_ID]);
	assert.deepEqual(stateList(db, world, runner), ["BID_PLACED"]);

	world.advance(30_000);
	world.houseAccepts();
	await runner.kick();
	assert.equal(world.pushes.length, 1, "the runner pushes the scripted tree once the job is funded");
	assert.deepEqual(recordOf(db)?.phase, "RAN");
	assert.deepEqual(stateList(db, world, runner), ["MONEY_HELD"]);

	// The process restarts between the push and the submit. The new runner picks the run up from its record.
	const restarted = createSampleRunner(portsOf(db, world));
	world.advance(30_000);
	await restarted.kick();
	assert.equal(placeBids(world).length, 1, "a restart does not bid again");
	const submit = world.commands.at(-1) as Extract<UserCommand, { type: "Submit" }>;
	assert.equal(submit.type, "Submit");
	assert.equal(submit.sourceCommit, world.pushes[0], "the submit names the commit the push produced");
	assert.deepEqual(stateList(db, world, restarted), ["VERIFYING"]);

	world.advance(60_000);
	world.verifierPasses(world.pushes[0]!);
	await restarted.kick();
	assert.deepEqual(recordOf(db)?.outcome, "VERIFIED");
	assert.deepEqual(stateList(db, world, restarted), ["AWAITING_APPROVAL"]);

	world.advance(60_000);
	world.houseApproves();
	await restarted.kick();
	assert.equal(placeBids(world).length, 1);
	assert.equal(world.commands.length, 2, "one bid and one submit, and no other command");

	const { activity, labels, runner: status } = activityFor(db, world, restarted);
	assert.deepEqual(labels, ACTIVITY_LABELS);
	assert.equal(status.status, "IDLE", "the run is done and no other starter is open");
	assert.equal(activity.length, 1);
	const [item] = activity;
	assert.equal(item?.state, "RELEASED");
	assert.equal(item?.source, "SAMPLE_RUNNER");
	assert.equal(item?.simulated, true);
	assert.equal(item?.label, "Sample agent · Simulated");
	assert.equal(item?.agentId, AGENT.id);
	assert.equal(item?.moneyHeld?.heldCents, BUDGET_CENTS);
	assert.deepEqual(item?.attempts.map(attempt => [attempt.result, attempt.frozen, attempt.hidden]), [["VERIFIED", { passed: 3, expected: 3 }, { passed: 4, expected: 4 }]]);
	assert.equal(item?.release?.payoutCents, PAID_CENTS);
	assert.equal(item?.release?.authority, "CLIENT_APPROVAL");
	assert.equal(item?.release?.payoutItemId, "PAYOUT_SAMPLE_1");
	assert.doesNotMatch(JSON.stringify(activityFor(db, world, restarted)), /CAPTURE_SAMPLE_1|op_other/, "no capture id or other operator leaves the server");
});

test("with the flag off, no tick reads, sends or writes, and the status reads OFF", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world, { enabled: false }));
	await runner.kick();
	assert.equal(world.commands.length, 0);
	assert.equal(sampleRunJobIds(db).size, 0);
	assert.equal(runner.statusOf(VISITOR, world.rows()).decision.status, "OFF");
});

test("a visitor with no fork is refused and nothing is bid, since a run never pushes upstream", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world, { visitors: () => [{ ...VISITOR, repository: null }] }));
	await runner.kick();
	assert.equal(world.commands.length, 0);
	const status = runner.statusOf({ ...VISITOR, repository: null }, world.rows());
	assert.equal(status.decision.status, "REFUSED");
	assert.equal(status.decision.reason, "NO_FORK");
});

test("the daily limit counts runs by bid time: three in 24 hours refuse a new bid, and an older run does not count", async () => {
	const now = new Date(START);
	const hoursAgo = (count: number) => new Date(now.getTime() - count * 3_600_000).toISOString();
	const seed = (db: DatabaseSync, placedAt: string[]) => placedAt.forEach((at, index) => db.prepare(
		"INSERT INTO sample_runner_runs (job_id, operator_id, agent_id, phase, placed_at, commit_sha, outcome, failures) VALUES (?, ?, ?, 'DONE', ?, NULL, 'VERIFIED', 0)",
	).run(`job_seed_${index}`, OPERATOR, AGENT.id, at));

	const full = new DatabaseSync(":memory:");
	const fullWorld = fakeWorld();
	const fullRunner = createSampleRunner(portsOf(full, fullWorld));
	seed(full, Array.from({ length: SAMPLE_RUNS_PER_DAY }, (_, index) => hoursAgo(index + 1)));
	await fullRunner.kick();
	assert.equal(fullWorld.commands.length, 0, "no bid once the day's limit is reached");
	const refused = fullRunner.statusOf(VISITOR, fullWorld.rows());
	assert.equal(refused.decision.reason, "DAILY_LIMIT");
	assert.equal(refused.runsToday, SAMPLE_RUNS_PER_DAY);

	const aged = new DatabaseSync(":memory:");
	const agedWorld = fakeWorld();
	const agedRunner = createSampleRunner(portsOf(aged, agedWorld));
	seed(aged, [...Array.from({ length: SAMPLE_RUNS_PER_DAY - 1 }, (_, index) => hoursAgo(index + 1)), hoursAgo(25)]);
	await agedRunner.kick();
	assert.equal(placeBids(agedWorld).length, 1, "a run older than 24 hours leaves the count, so the next bid goes ahead");
	assert.equal(agedRunner.statusOf(VISITOR, agedWorld.rows()).runsToday, SAMPLE_RUNS_PER_DAY - 1 + 1);
});

test("a fork that keeps refusing the push closes the run after five failures, and the error text stays out of the log", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld(new Error("push rejected, token FAKE-PUSH-TOKEN-FOR-TEST"));
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	world.houseAccepts();
	for (let tick = 0; tick < 5; tick++) await runner.kick();
	assert.equal(world.pushes.length, 0);
	const closed = recordOf(db);
	assert.equal(closed?.phase, "DONE");
	assert.equal(closed?.commit_sha, null);
	assert.equal(closed?.outcome, "CLOSED");
	assert.equal(closed?.failures, 5);
	await runner.kick();
	assert.equal(placeBids(world).length, 1, "a closed run is not bid on again");
	assert.ok(world.logs.some(line => line.includes("closed after 5 failures")));
	assert.ok(!world.logs.some(line => line.includes("FAKE-PUSH-TOKEN-FOR-TEST")), "the error message never reaches the log");
});

test("the activity limit reads 1 to 50, defaults to 20, and refuses anything else", () => {
	assert.equal(activityLimit(null), 20);
	assert.equal(activityLimit("1"), 1);
	assert.equal(activityLimit("50"), 50);
	for (const raw of ["0", "51", "-1", "2.5", "abc", ""]) assert.equal(activityLimit(raw), null, `"${raw}" is refused`);
});

test("the activity lists only the operator's own jobs, labels the runner's, and never shows another operator's bid", () => {
	const sampled = storedRow(JOB_ID, { client: HOUSE_CLIENT_ID, tenant: VISITOR.id, state: heldState("2026-11-11T12:05:30.000Z"),
		bids: [{ id: "bid_sample", operator: OPERATOR, agent: AGENT.id, price: 1_000, placedAt: "2026-11-11T12:05:00.000Z", status: "ACCEPTED" }] });
	const owned = storedRow("job_owner_cli", { client: "maya-client", tenant: VISITOR.id, state: heldState("2026-11-11T11:00:30.000Z"),
		bids: [{ id: "bid_owner", operator: OPERATOR, agent: "owner-agent", price: 2_000, placedAt: "2026-11-11T11:00:00.000Z", status: "ACCEPTED" }] });
	const otherOperator = storedRow("job_other", { client: "maya-client", tenant: null, state: openState,
		bids: [{ id: "bid_other", operator: "op_other", agent: "other-agent", price: 1_000, placedAt: "2026-11-11T12:06:00.000Z", status: "PENDING" }] });
	const returned = storedRow("job_returned", { client: "maya-client", tenant: null, state: openState,
		bids: [{ id: "bid_returned", operator: OPERATOR, agent: "owner-agent", price: 1_000, placedAt: "2026-11-11T12:07:00.000Z", status: "RETURNED" }] });
	const rows = [otherOperator, owned, sampled, returned];
	const input = { operatorId: OPERATOR as OperatorId, limit: 20, rows, sampleJobIds: new Set([JOB_ID]), enabled: false, runner: null };

	const json = activityJson(input);
	assert.equal(json.sandbox, true);
	assert.deepEqual(json.activity.map(item => item.jobId), [JOB_ID, "job_owner_cli"], "newest first, no other operator's or returned job");
	const [fromRunner, fromOwner] = json.activity;
	assert.equal(fromRunner?.source, "SAMPLE_RUNNER");
	assert.equal(fromRunner?.simulated, true);
	assert.equal(fromRunner?.label, "Sample agent · Simulated");
	assert.equal(fromOwner?.source, "OWNER");
	assert.equal(fromOwner?.simulated, false);
	assert.equal(fromOwner?.label, null);
	assert.equal(fromOwner?.agentId, "owner-agent");
	assert.equal(fromOwner?.state, "MONEY_HELD");
	assert.equal(json.runner.status, "OFF", "a flag-off deployment reads OFF with no visitor's run");
	assert.doesNotMatch(JSON.stringify(json), /op_other/);
	assert.equal(activityJson({ ...input, limit: 1 }).activity.length, 1);
	assert.equal(activityJson({ ...input, enabled: true }).runner.status, "IDLE");
});
