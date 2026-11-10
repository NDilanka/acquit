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
import type { DefinitionOfDone } from "../../../packages/core/src/verifier.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { manifestOf } from "../../../packages/core/src/fixtures.ts";
import { commercialSplit, usd, type UsdCents } from "../../../packages/core/src/ledger.ts";
import { quote, type Bps, type ProcessorFeeModel } from "../../../packages/core/src/paypal.ts";
import { demoFixture, jpyFixture } from "../../../packages/core/test/hidden-fixture.ts";
import type { ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import { stepKey } from "../../../packages/core/src/scenario-binding.ts";
import { SAMPLE_RUNS_PER_DAY, SAMPLE_VERIFIER_RETRIES, type SampleOrders } from "../../../packages/core/src/sample-runner.ts";
import { activityJson, activityLimit, ACTIVITY_LABELS } from "../src/sample-activity.ts";
import { createSampleRunner, sampleRunJobs, type SampleFixtureRule, type SampleRunnerAgent, type SampleRunnerPorts, type SampleRunnerVisitor } from "../src/sample-runner.ts";

const OPERATOR = "op_sample_visitor";
/** The visitor's own fork, named the way the registry's `acquit-forks/` prefix names a visitor's workspace repository. */
const FORK = "acquit-forks/ws-aabbcc112233";
const VISITOR: SampleRunnerVisitor = { id: "v_sample" as VisitorId, operatorHandle: OPERATOR, repository: FORK };
const AGENT = { id: "code-sample-visitor", task: "code", sample: true, acquitted: true };
const ORDERS: SampleOrders = { autopilot: true, runsOn: "acquit", priceFloorCents: 1_000 };
/** The scenario fixture the registry carries: issue 12 on the client repository, whose forks the visitor opens. */
const SCENARIO = demoFixture();
const OTHER_ISSUE = jpyFixture();
const FIXTURE_RULE: SampleFixtureRule = { fixtures: [SCENARIO, OTHER_ISSUE], upstream: SCENARIO.repository,
	scenario: { repository: SCENARIO.repository, issueNumber: SCENARIO.issue.number } };
const JOB_ID = "job_starter_1";
const SECOND_JOB_ID = "job_starter_2";
/** The House's fee model in the deployment's shape. AcceptBid quotes every accepted bid with it. */
const FEE_MODEL: ProcessorFeeModel = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const BUDGET_CENTS = 5_000;
const PAID_CENTS = 4_750;
const START = Date.parse("2026-11-11T12:00:00.000Z");

type PlaceBid = Extract<UserCommand, { type: "PlaceBid" }>;

/** A stored job row, carrying the fields the runner and the activity read. */
function storedRow(id: string, fields: { client: string; tenant: string | null; state: object; bids: object[]; definition?: DefinitionOfDone | null }): JobRow {
	return {
		id, version: 1, client: fields.client, tenant: fields.tenant, title: `Job ${id}`, openedAt: "2026-11-11T10:00:00.000Z",
		contract: { budget: BUDGET_CENTS, deliveryEndsAt: "2026-11-13T12:00:00.000Z", definitionOfDone: fields.definition ?? null },
		bids: fields.bids, state: fields.state,
	} as unknown as JobRow;
}

const openState = { status: "OPEN", phase: { kind: "BIDDING" } };

function heldState(at: string, phase: "READY" | "VERIFYING" = "READY", runsStarted = 0) {
	return {
		status: "IN_PROGRESS",
		escrow: { payee: { operator: OPERATOR }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at }] },
		attempts: { phase, history: [], runsStarted, failure: null },
	};
}

/** The fake world: one starter job on the House client, the command edge, the House client's steps, and the push. */
/** The starter the House opens for the visitor: the scenario fixture's manifest, on the visitor's own fork. */
function starterManifest(fixture = SCENARIO): DefinitionOfDone {
	return manifestOf(fixture, FORK);
}

function fakeWorld(pushError: Error | null = null, definition: DefinitionOfDone | null = starterManifest()) {
	let at = START;
	let failure = pushError;
	/** The reason every bid is refused with, or null for the House taking bids. */
	let refusal: string | null = null;
	let rows: JobRow[] = [storedRow(JOB_ID, { client: HOUSE_CLIENT_ID, tenant: VISITOR.id, state: openState, bids: [], definition })];
	let lastRecord: object = {};
	const actors: Actor[] = [];
	const commands: UserCommand[] = [];
	/** Every command with the request key it was sent under, so a test can check which key each step used. */
	const sent: { readonly command: UserCommand; readonly key: RequestKey }[] = [];
	const pushes: CommitSha[] = [];
	const logs: string[] = [];

	const now = () => new Date(at).toISOString();
	const jobRow = (): JobRow => {
		const row = rows.find(entry => entry.id === JOB_ID);
		if (row === undefined) throw new Error("the fake job is missing");
		return row;
	};
	const patchJob = (jobId: string, fields: Record<string, unknown>) => {
		rows = rows.map(row => (row.id === jobId ? ({ ...row, ...fields } as unknown as JobRow) : row));
	};
	const patch = (fields: Record<string, unknown>) => patchJob(JOB_ID, fields);
	const runsStarted = () => (jobRow().state as { readonly attempts: { readonly runsStarted: number } }).attempts.runsStarted;

	const execute = async (actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome> => {
		actors.push(actor);
		commands.push(command);
		sent.push({ command, key });
		if (command.type === "PlaceBid") {
			if (refusal !== null) return { kind: "DENIED", reason: refusal } as unknown as CommandOutcome;
			const bid = { id: `bid_${commands.length}`, operator: OPERATOR, agent: command.agent, price: command.price,
				eta: command.eta, pitch: command.pitch, placedAt: now(), respondBy: new Date(at + 72 * 60 * 60_000).toISOString(), status: "PENDING" };
			patchJob(command.jobId, { bids: [bid] });
			return { kind: "COMMITTED", result: { kind: "BID", job: { id: JOB_ID }, bid, creditsLeft: 4 } } as unknown as CommandOutcome;
		}
		if (command.type === "Submit") {
			// Each Submit starts the next verifier run, as job.ts does: runsStarted counts every run, verdict or not.
			patch({ state: heldState(now(), "VERIFYING", runsStarted() + 1) });
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
		actors, commands, sent, pushes, logs, now, rows: () => rows, jobRow, execute, workspace,
		advance: (ms: number) => { at += ms; },
		/** A second starter on the visitor's fork, for a test that needs the runner to bid again. */
		addStarter: (id: string) => { rows = [...rows, storedRow(id, { client: HOUSE_CLIENT_ID, tenant: VISITOR.id, state: openState, bids: [], definition: starterManifest() })]; },
		/** Every bid is refused with this reason, or the House takes bids again when it is null. */
		refuseBids: (reason: string | null) => { refusal = reason; },
		log: (line: string) => { logs.push(line); },
		/** The House client accepts the bid and funds the job. */
		houseAccepts: () => patch({ bids: jobRow().bids.map(bid => ({ ...bid, status: "ACCEPTED" })), state: heldState(now()) }),
		/** The verifier run ends with no verdict, as a publish or deadline failure does: the attempt is READY again, nothing is judged. */
		verifierRunFails: () => patch({ state: heldState(now(), "READY", runsStarted()) }),
		/** The House refunds the held job, as a delivery deadline does. The job is no longer IN_PROGRESS, so it holds no money. */
		houseRefunds: () => patch({ state: { status: "REFUNDED", payee: { operator: OPERATOR }, book: [], reason: "DELIVERY_DEADLINE",
			refund: { refundId: null, captureId: "CAPTURE_SAMPLE_1", refunded: BUDGET_CENTS, retainedProcessorFee: 0, at: now() }, history: [], treasury: [] } }),
		/** The real verifier passes the commit. */
		verifierPasses: (commit: CommitSha) => {
			lastRecord = { ordinal: 1, verdict: { result: "VERIFIED", runId: "run_sample_1", sourceCommit: commit,
				mergeCommit: "f".repeat(40), frozen: { passed: 3, expected: 3 }, hidden: { passed: 4, expected: 4 },
				reportDigest: "0".repeat(64), at: now() } };
			patch({ state: { status: "VERIFIED", escrow: { payee: { operator: OPERATOR }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at: now() }] },
				history: [lastRecord], passed: true, review: { phase: "AWAITING_CLIENT", endsAt: new Date(at + 60_000).toISOString() }, runsStarted: runsStarted() } });
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
		jobsOf: () => world.rows(),
		agentsOf: handle => (handle === OPERATOR ? [AGENT] : []),
		ordersOf: () => ORDERS,
		fixtureRule: FIXTURE_RULE,
		feeModel: FEE_MODEL,
		execute: world.execute,
		workspace: world.workspace,
		...overrides,
	};
}

function recordOf(db: DatabaseSync) {
	return db.prepare("SELECT phase, commit_sha, outcome, failures, closed_reason FROM sample_runner_runs WHERE job_id = ?").get(JOB_ID) as
		{ readonly phase: string; readonly commit_sha: string | null; readonly outcome: string | null; readonly failures: number; readonly closed_reason: string | null } | undefined;
}

function placeBids(world: World): PlaceBid[] {
	return world.commands.filter((command): command is PlaceBid => command.type === "PlaceBid");
}

function submitsOf(world: World) {
	return world.sent.filter(entry => entry.command.type === "Submit");
}

/** Standing orders the test can change between reads, so an owner's switch can land inside one tick. */
function ordersSwitch() {
	let current: SampleOrders = ORDERS;
	let reads = 0;
	let flipOnRead = -1;
	return {
		ordersOf: (): SampleOrders => {
			reads += 1;
			if (reads === flipOnRead) current = { ...ORDERS, autopilot: false };
			return current;
		},
		set: (autopilot: boolean) => { current = { ...ORDERS, autopilot }; },
		/** Turns autopilot off between a tick's decision and its send. The decision reads the orders once, the send again. */
		flipBeforeSend: () => { flipOnRead = reads + 2; },
	};
}

function activityFor(db: DatabaseSync, world: World, runner: ReturnType<typeof createSampleRunner>) {
	return activityJson({
		operatorId: OPERATOR as OperatorId, limit: 20, rows: world.rows(), sampleJobs: sampleRunJobs(db, OPERATOR), enabled: true,
		runner: runner.statusOf(VISITOR),
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
	assert.deepEqual([...sampleRunJobs(db, OPERATOR).keys()], [JOB_ID]);
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
	assert.equal(sampleRunJobs(db, OPERATOR).size, 0);
	assert.equal(runner.statusOf(VISITOR).decision.status, "OFF");
});

test("a visitor with no fork is refused and nothing is bid, since a run never pushes upstream", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world, { visitors: () => [{ ...VISITOR, repository: null }] }));
	await runner.kick();
	assert.equal(world.commands.length, 0);
	const status = runner.statusOf({ ...VISITOR, repository: null });
	assert.equal(status.decision.status, "REFUSED");
	assert.equal(status.decision.reason, "NO_FORK");
});

test("the runner bids only on a starter the registry's own rule matches to the scenario fixture, on the visitor's own fork", async () => {
	const bidsFor = async (definition: DefinitionOfDone | null, rule: SampleFixtureRule = FIXTURE_RULE): Promise<number> => {
		const db = new DatabaseSync(":memory:");
		const world = fakeWorld(null, definition);
		const runner = createSampleRunner(portsOf(db, world, { fixtureRule: rule }));
		await runner.kick();
		return placeBids(world).length;
	};
	assert.equal(await bidsFor(starterManifest()), 1, "the scenario fixture's starter on the visitor's fork is bid on");
	assert.equal(await bidsFor(starterManifest(OTHER_ISSUE)), 0, "another issue on the same upstream is not bid on");
	assert.equal(await bidsFor(starterManifest(), { ...FIXTURE_RULE, upstream: null }), 0, "with no client repository, a fork names no fixture");
	assert.equal(await bidsFor(starterManifest(), { ...FIXTURE_RULE, scenario: null }), 0, "a deployment with no scenario fixture runs no sample");
	assert.equal(await bidsFor(manifestOf(SCENARIO, SCENARIO.repository)), 0, "a starter on the upstream itself is not bid on, since a run never pushes there");
	assert.equal(await bidsFor(manifestOf(SCENARIO, "acquit-forks/ws-ffeeddcc1122")), 0, "a starter on another visitor's fork is not bid on");
	assert.equal(await bidsFor(null), 0, "a job with no stored manifest is not bid on");

	const db = new DatabaseSync(":memory:");
	const world = fakeWorld(null, starterManifest(OTHER_ISSUE));
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	assert.equal(runner.statusOf(VISITOR).decision.status, "IDLE", "no matching starter is an idle visitor, not a refusal");
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
	const refused = fullRunner.statusOf(VISITOR);
	assert.equal(refused.decision.reason, "DAILY_LIMIT");
	assert.equal(refused.runsToday, SAMPLE_RUNS_PER_DAY);

	const aged = new DatabaseSync(":memory:");
	const agedWorld = fakeWorld();
	const agedRunner = createSampleRunner(portsOf(aged, agedWorld));
	seed(aged, [...Array.from({ length: SAMPLE_RUNS_PER_DAY - 1 }, (_, index) => hoursAgo(index + 1)), hoursAgo(25)]);
	await agedRunner.kick();
	assert.equal(placeBids(agedWorld).length, 1, "a run older than 24 hours leaves the count, so the next bid goes ahead");
	assert.equal(agedRunner.statusOf(VISITOR).runsToday, SAMPLE_RUNS_PER_DAY - 1 + 1);
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

test("a push the fork keeps refusing closes the run with its reason stored: delivery stops until the House lets the job go", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld(new Error("push rejected, token FAKE-PUSH-TOKEN-FOR-TEST"));
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	world.houseAccepts();
	for (let tick = 0; tick < 5; tick++) await runner.kick();
	assert.equal(recordOf(db)?.outcome, "CLOSED");
	assert.equal(recordOf(db)?.closed_reason, "push failed (Error)", "the stored reason names the failure, never its message");
	assert.equal(sampleRunJobs(db, OPERATOR).get(JOB_ID), "push failed (Error)");
	const stopped = runner.statusOf(VISITOR);
	assert.equal(stopped.decision.status, "REFUSED");
	assert.equal(stopped.decision.reason, "DELIVERY_STOPPED", "the House still holds the money, so delivery stays stopped");
	assert.deepEqual(stateList(db, world, runner), ["CLOSED"]);

	world.addStarter(SECOND_JOB_ID);
	await runner.kick();
	assert.equal(placeBids(world).length, 1, "no other starter is bid on while the House holds the money");

	// A restart reads the stored reason from the record, so the stop survives it.
	const restarted = createSampleRunner(portsOf(db, world));
	await restarted.kick();
	assert.equal(restarted.statusOf(VISITOR).decision.reason, "DELIVERY_STOPPED");
	assert.equal(placeBids(world).length, 1, "a restart does not bid either");

	// The House refunds the held job. It holds no money now, so the stop ends and the next starter is bid on.
	world.houseRefunds();
	await restarted.kick();
	assert.deepEqual(placeBids(world).map(command => command.jobId), [JOB_ID, SECOND_JOB_ID],
		"once the job leaves IN_PROGRESS, the next starter is bid on");
	assert.equal(recordOf(db)?.closed_reason, "push failed (Error)", "the closed run keeps its reason");
});

test("a verifier run that ends with no verdict is resubmitted under a new key, and the run closes once its retries fail", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	world.houseAccepts();
	await runner.kick();
	const commit = world.pushes[0]!;
	await runner.kick(); // submit, verifier run 1
	// Each run ends with no verdict. The next tick resubmits, and the last tick closes the run.
	for (let run = 1; run <= SAMPLE_VERIFIER_RETRIES + 1; run++) {
		world.verifierRunFails();
		await runner.kick();
	}
	const submits = submitsOf(world);
	assert.deepEqual(submits.map(entry => entry.key), [1, 2, 3].map(run => stepKey(`sample:${JOB_ID}`, `submit:${run}`)),
		"each verifier run is submitted under its own key, so a replay cannot return the first answer");
	assert.ok(submits.every(entry => entry.command.type === "Submit" && entry.command.sourceCommit === commit), "every run judges the pushed commit");
	assert.equal(recordOf(db)?.phase, "DONE");
	assert.equal(recordOf(db)?.outcome, "CLOSED");
	assert.ok(world.logs.some(line => line.includes("verifier gave no verdict in 3 runs")));
	await runner.kick();
	assert.equal(submitsOf(world).length, submits.length, "a closed run is not submitted again");
});

test("a verifier chain that closes the run while the House holds the money stops delivery, and the activity says closed, not held", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	world.houseAccepts();
	await runner.kick();
	await runner.kick(); // submit, verifier run 1
	for (let run = 1; run <= SAMPLE_VERIFIER_RETRIES + 1; run++) {
		world.verifierRunFails();
		await runner.kick();
	}
	assert.equal(recordOf(db)?.outcome, "CLOSED");
	assert.equal(recordOf(db)?.closed_reason, "verifier gave no verdict in 3 runs");
	const stopped = runner.statusOf(VISITOR);
	assert.equal(stopped.decision.status, "REFUSED");
	assert.equal(stopped.decision.reason, "DELIVERY_STOPPED", "not IDLE: the run ended, but the House still holds the money");
	const [item] = activityFor(db, world, runner).activity;
	assert.equal(item?.state, "CLOSED", "not MONEY_HELD: no more delivery runs go out on this job");
	assert.equal(item?.closedReason, "verifier gave no verdict in 3 runs");
	assert.equal(item?.moneyHeld?.heldCents, BUDGET_CENTS, "the held line stays until the job leaves IN_PROGRESS");

	world.addStarter(SECOND_JOB_ID);
	await runner.kick();
	assert.equal(placeBids(world).length, 1, "no other starter is bid on while the House holds the money");
	assert.equal(submitsOf(world).length, SAMPLE_VERIFIER_RETRIES + 1, "the closed run is not submitted again");
});

test("a retry the verifier judges is recorded as VERIFIED, like a first run", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	world.houseAccepts();
	await runner.kick();
	const commit = world.pushes[0]!;
	await runner.kick(); // submit, verifier run 1
	world.verifierRunFails();
	await runner.kick(); // submit, verifier run 2
	assert.deepEqual(submitsOf(world).map(entry => entry.key), [1, 2].map(run => stepKey(`sample:${JOB_ID}`, `submit:${run}`)));
	world.verifierPasses(commit);
	await runner.kick();
	assert.equal(recordOf(db)?.outcome, "VERIFIED");
	assert.equal(submitsOf(world).length, 2, "a judged run is not submitted again");
});

test("an owner who turns autopilot off stops the run's next push or submit, the status says why, and a verdict is still recorded", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	const orders = ordersSwitch();
	const runner = createSampleRunner(portsOf(db, world, { ordersOf: orders.ordersOf }));
	await runner.kick();
	world.houseAccepts();
	orders.set(false);
	await runner.kick();
	assert.equal(world.pushes.length, 0, "no push while autopilot is off");
	assert.equal(recordOf(db)?.phase, "BID");
	const paused = runner.statusOf(VISITOR);
	assert.equal(paused.decision.status, "REFUSED");
	assert.equal(paused.decision.reason, "AUTOPILOT_OFF");

	// Autopilot is back on, but the owner switches it off again between the tick's decision and its push.
	orders.set(true);
	orders.flipBeforeSend();
	await runner.kick();
	assert.equal(world.pushes.length, 0, "a switch between the decision and the push stops the push");
	assert.ok(world.logs.some(line => line.includes(`${JOB_ID} push not sent: autopilot is off`)));

	orders.set(true);
	await runner.kick();
	assert.equal(world.pushes.length, 1, "with autopilot on, the push goes ahead");
	const commit = world.pushes[0]!;
	assert.equal(recordOf(db)?.phase, "RAN");

	orders.flipBeforeSend();
	await runner.kick();
	assert.equal(submitsOf(world).length, 0, "a switch between the decision and the submit stops the submit");
	assert.ok(world.logs.some(line => line.includes(`${JOB_ID} submit not sent: autopilot is off`)));
	assert.equal(recordOf(db)?.phase, "RAN");

	orders.set(true);
	await runner.kick();
	assert.equal(submitsOf(world).length, 1, "with autopilot on, the submit goes ahead");

	orders.set(false);
	const sentBefore = world.sent.length;
	world.verifierPasses(commit);
	await runner.kick();
	assert.equal(recordOf(db)?.outcome, "VERIFIED", "the real verdict is recorded even while autopilot is off");
	assert.equal(world.sent.length, sentBefore, "a recorded verdict sends nothing");
	assert.equal(runner.statusOf(VISITOR).decision.status, "IDLE");
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
	const input = { operatorId: OPERATOR as OperatorId, limit: 20, rows, sampleJobs: new Map([[JOB_ID, null]]), enabled: false, runner: null };

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

test("an open job reads FUNDING only when this operator's own bid was chosen, never for another operator's choice", () => {
	const chosen = storedRow("job_own_chosen", { client: "maya-client", tenant: null, state: { status: "OPEN", phase: { kind: "FUNDING" } },
		bids: [{ id: "bid_own", operator: OPERATOR, agent: "owner-agent", price: 1_000, placedAt: "2026-11-11T11:00:00.000Z", status: "CHOSEN" }] });
	const contested = storedRow("job_contested", { client: "maya-client", tenant: null, state: { status: "OPEN", phase: { kind: "FUNDING" } },
		bids: [
			{ id: "bid_mine", operator: OPERATOR, agent: "owner-agent", price: 1_000, placedAt: "2026-11-11T11:00:00.000Z", status: "PENDING" },
			{ id: "bid_theirs", operator: "op_other", agent: "other-agent", price: 900, placedAt: "2026-11-11T11:01:00.000Z", status: "CHOSEN" },
		] });
	const json = activityJson({ operatorId: OPERATOR as OperatorId, limit: 20, rows: [chosen, contested], sampleJobs: new Map(), enabled: false, runner: null });
	const states = new Map(json.activity.map(item => [item.jobId, item.state]));
	assert.equal(states.get("job_own_chosen"), "FUNDING");
	assert.equal(states.get("job_contested"), "BID_PLACED", "the other operator's chosen bid is not this operator's funding");
	assert.doesNotMatch(JSON.stringify(json), /op_other/);
});

test("a bid the House refuses for good holds the runner for a day, and the next starter is bid on after that", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	world.refuseBids("DEADLINE_PASSED");
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	assert.equal(placeBids(world).length, 1);
	assert.equal(recordOf(db)?.phase, "DONE");
	assert.equal(recordOf(db)?.outcome, "BID_DENIED");
	assert.ok(world.logs.some(line => line.includes(`${JOB_ID} BID_DENIED: DEADLINE_PASSED`)));
	const held = runner.statusOf(VISITOR);
	assert.equal(held.decision.status, "REFUSED");
	assert.equal(held.decision.reason, "BID_DENIED");
	assert.equal(held.runsToday, 0, "a refused bid is not one of the day's runs");

	world.refuseBids(null);
	world.addStarter(SECOND_JOB_ID);
	world.advance(23 * 3_600_000);
	await runner.kick();
	assert.equal(placeBids(world).length, 1, "no bid within 24 hours of the refusal");
	assert.equal(runner.statusOf(VISITOR).decision.reason, "BID_DENIED");

	world.advance(2 * 3_600_000);
	await runner.kick();
	assert.deepEqual(placeBids(world).map(command => command.jobId), [JOB_ID, SECOND_JOB_ID],
		"the next starter is bid on once the hold lapses, and the refused job is not bid on again");
});

test("a transient bid refusal keeps no run, so the same starter is bid on the next tick, with no day's wait", async () => {
	// The visitor has no credits yet: the House refuses with INSUFFICIENT_CREDITS, then the credits are granted.
	for (const reason of ["INSUFFICIENT_CREDITS", "WRONG_STATE", "ONBOARDING_REQUIRED"]) {
		const db = new DatabaseSync(":memory:");
		const world = fakeWorld();
		world.refuseBids(reason);
		const runner = createSampleRunner(portsOf(db, world));
		await runner.kick();
		assert.equal(recordOf(db), undefined, `${reason} keeps no run record`);
		assert.ok(world.logs.some(line => line.includes(`${JOB_ID} bid not placed: ${reason}; the next tick retries`)));
		assert.notEqual(runner.statusOf(VISITOR).decision.reason, "BID_DENIED", `${reason} does not hold the runner for a day`);

		world.refuseBids(null);
		await runner.kick();
		assert.deepEqual(placeBids(world).map(command => command.jobId), [JOB_ID, JOB_ID],
			`after ${reason}, the same starter is bid on the next tick, without advancing the clock`);
		assert.equal(recordOf(db)?.phase, "BID");
	}
});

test("a bid the job is busy for leaves no run record, so the next tick bids again", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	world.refuseBids("BUSY");
	const runner = createSampleRunner(portsOf(db, world));
	await runner.kick();
	assert.equal(placeBids(world).length, 4, "the bid is retried while the job is busy, then the tick gives up");
	assert.equal(recordOf(db), undefined, "no record is kept for a bid the House never took");
	assert.ok(world.logs.some(line => line.includes(`${JOB_ID} bid not placed: BUSY; the next tick retries`)));

	world.refuseBids(null);
	await runner.kick();
	assert.equal(placeBids(world).length, 5, "the next tick bids again");
	assert.equal(recordOf(db)?.phase, "BID");
});

/** A command edge that waits on the gate before it reaches the fake, so a test can hold a tick inside one command. */
function gatedExecute(world: World, gate: Promise<void>): SampleRunnerPorts["execute"] {
	return async (actor, key, command) => {
		await gate;
		return world.execute(actor, key, command);
	};
}

test("shutdown waits for the tick in flight, and a kick during that tick joins it rather than starting another", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const runner = createSampleRunner(portsOf(db, world, { execute: gatedExecute(world, gate) }));
	const tick = runner.kick();
	assert.strictEqual(runner.kick(), tick, "a kick while a tick runs returns that tick");
	let drained = false;
	const draining = runner.drain().then(() => { drained = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(drained, false, "drain waits while the bid is still in flight");
	release();
	await draining;
	assert.equal(placeBids(world).length, 1, "one tick placed one bid");
	assert.equal(recordOf(db)?.phase, "BID");
});

test("two processes on one database take turns through the lease, so a second tick never bids while the first holds it", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const first = createSampleRunner(portsOf(db, world, { execute: gatedExecute(world, gate) }));
	const second = createSampleRunner(portsOf(db, world));
	const firstTick = first.kick();
	await second.kick();
	assert.equal(world.commands.length, 0, "the second process waits while the first holds the lease");
	release();
	await firstTick;
	assert.equal(placeBids(world).length, 1);
	await second.kick();
	assert.equal(placeBids(world).length, 1, "the next tick sees the run in flight and bids on nothing else");
});

test("a tick that never finishes frees the lease two minutes later, and a bid it never sent ends its run as BID_LOST", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	// The first process hangs inside its bid. It wrote the run record and holds the lease, and it never returns.
	const hung = createSampleRunner(portsOf(db, world, { execute: () => new Promise<CommandOutcome>(() => {}) }));
	void hung.kick();
	const survivor = createSampleRunner(portsOf(db, world));
	world.advance(2 * 60_000 - 1_000);
	await survivor.kick();
	assert.equal(world.commands.length, 0, "the lease is still held inside its two minutes");
	world.advance(2_000);
	await survivor.kick();
	assert.equal(recordOf(db)?.outcome, "BID_LOST", "the bid was never sent, so the run ends without a bid");
	assert.equal(placeBids(world).length, 0, "the job is not bid on again once a run holds it");
});

test("a run keeps its own agent until it finishes, even once that agent is no longer a sample, and takes its verdict", async () => {
	const db = new DatabaseSync(":memory:");
	const world = fakeWorld();
	let agents: SampleRunnerAgent[] = [AGENT];
	const runner = createSampleRunner(portsOf(db, world, { agentsOf: handle => (handle === OPERATOR ? agents : []) }));
	await runner.kick();
	world.houseAccepts();
	await runner.kick(); // push
	await runner.kick(); // submit, verifier run 1
	const commit = world.pushes[0]!;
	agents = [{ ...AGENT, sample: false }, { ...AGENT, id: "code-second-sample" }];
	assert.equal(runner.statusOf(VISITOR).decision.reason, "NOT_A_SAMPLE", "the run waits while its agent is not a sample");
	world.verifierPasses(commit);
	await runner.kick();
	assert.equal(recordOf(db)?.outcome, "VERIFIED", "the run still takes its verdict");
	assert.equal(submitsOf(world).length, 1, "no further submit once consent is gone");
	assert.equal(runner.statusOf(VISITOR).decision.status, "IDLE", "the sample agent listed now has no starter to bid on");
});

const OLD_OPERATOR = "op_old_visitor";
const OLD_FORK = "acquit-forks/ws-010203040506";
const OLD_VISITOR: SampleRunnerVisitor = { id: "v_old" as VisitorId, operatorHandle: OLD_OPERATOR, repository: OLD_FORK };
const OLD_AGENT = { id: "code-sample-old", task: "code", sample: true, acquitted: true };
const OLD_JOB_ID = "job_old_starter";
/** The older visitor's standing orders: a one-cent floor, which the House cannot fund. */
const ONE_CENT_ORDERS: SampleOrders = { autopilot: true, runsOn: "acquit", priceFloorCents: 1 };

/** The fields of an OPEN job the House accepts into: funded, with the operator's own payee, and its first run ready. */
function fundedFor(operator: string, at: string) {
	return { status: "IN_PROGRESS", escrow: { payee: { operator }, book: [{ kind: "HELD", cents: BUDGET_CENTS, at }] },
		attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } };
}

test("a price floor the House cannot fund is never bid, so it cannot stop the House's accept pass for another visitor's starter", async () => {
	assert.throws(() => quote(commercialSplit(usd("0.01")), FEE_MODEL), /Price cannot carry processing fee/,
		"the House's own quote fails at one cent, so an accept at that price would throw");

	const db = new DatabaseSync(":memory:");
	let at = START;
	const now = () => new Date(at).toISOString();
	// The older visitor's starter comes first, since the House's pass reads its jobs oldest first.
	let rows: JobRow[] = [
		storedRow(OLD_JOB_ID, { client: HOUSE_CLIENT_ID, tenant: OLD_VISITOR.id, state: openState, bids: [], definition: manifestOf(SCENARIO, OLD_FORK) }),
		storedRow(JOB_ID, { client: HOUSE_CLIENT_ID, tenant: VISITOR.id, state: openState, bids: [], definition: starterManifest() }),
	];
	const patchRow = (jobId: string, fields: Record<string, unknown>) => {
		rows = rows.map(row => (row.id === jobId ? ({ ...row, ...fields } as unknown as JobRow) : row));
	};
	const statusOfRow = (jobId: string): string | undefined =>
		(rows.find(row => row.id === jobId)?.state as { readonly status: string } | undefined)?.status;
	const commands: UserCommand[] = [];
	const pushes: CommitSha[] = [];
	const logs: string[] = [];

	const execute = async (actor: Actor, _key: RequestKey, command: UserCommand): Promise<CommandOutcome> => {
		commands.push(command);
		if (command.type === "Submit") return { kind: "COMMITTED", result: { kind: "JOB", job: { id: command.jobId } } } as unknown as CommandOutcome;
		if (command.type !== "PlaceBid" || actor.role !== "OPERATOR") throw new Error(`the fake has no ${command.type}`);
		const bid = { id: `bid_${commands.length}`, operator: actor.operatorId, agent: command.agent, price: command.price,
			eta: command.eta, pitch: command.pitch, placedAt: now(), respondBy: new Date(at + 72 * 60 * 60_000).toISOString(), status: "PENDING" };
		patchRow(command.jobId, { bids: [bid] });
		return { kind: "COMMITTED", result: { kind: "BID", job: { id: command.jobId }, bid, creditsLeft: 4 } } as unknown as CommandOutcome;
	};

	/**
	 * The House's accept pass, as the core runs it: each job oldest first, each pending bid past its 30-second window
	 * accepted and funded. The accept quotes the bid's price with the House's fee model, and a quote that throws stops
	 * the whole pass, so every visitor's job waits behind it.
	 */
	const houseAcceptPass = () => {
		for (const row of rows) {
			for (const bid of row.bids) {
				if (bid.status !== "PENDING" || at - Date.parse(bid.placedAt) < 30_000) continue;
				quote(commercialSplit(bid.price), FEE_MODEL);
				patchRow(row.id, { bids: [{ ...bid, status: "ACCEPTED" }], state: fundedFor(bid.operator, now()) });
			}
		}
	};

	const runner = createSampleRunner({
		db, enabled: true, now, log: line => { logs.push(line); },
		visitors: () => [OLD_VISITOR, VISITOR],
		jobsOf: () => rows,
		agentsOf: handle => (handle === OLD_OPERATOR ? [OLD_AGENT] : handle === OPERATOR ? [AGENT] : []),
		ordersOf: agentId => (agentId === OLD_AGENT.id ? ONE_CENT_ORDERS : ORDERS),
		fixtureRule: FIXTURE_RULE,
		feeModel: FEE_MODEL,
		execute,
		workspace: { push: async () => {
			const commit = String(pushes.length + 1).padStart(40, "0") as CommitSha;
			pushes.push(commit);
			return commit;
		} },
	});

	await runner.kick();
	assert.deepEqual(commands.map(command => (command.type === "PlaceBid" ? command.jobId : command.type)), [JOB_ID],
		"the one-cent floor places no bid, and the other visitor's starter is bid on");
	assert.equal(runner.statusOf(OLD_VISITOR).decision.reason, "PRICE_CANNOT_CARRY_FEE", "the status says why the older visitor waits");
	assert.ok(logs.some(line => line.includes("the price floor of 1 cents cannot carry the processing fee")), "the log says why nothing is bid");

	at += 31_000;
	assert.doesNotThrow(houseAcceptPass, "the accept pass runs through, so the other visitor's bid is accepted");
	assert.equal(statusOfRow(JOB_ID), "IN_PROGRESS", "the other visitor's starter is funded");
	assert.equal(statusOfRow(OLD_JOB_ID), "OPEN", "the older visitor's starter stays open, with no bid on it");

	await runner.kick();
	assert.equal(pushes.length, 1, "the other visitor's run pushes its commit");
	assert.equal(runner.statusOf(VISITOR).decision.status, "RUNNING");

	at += 31_000;
	assert.doesNotThrow(houseAcceptPass, "later passes still run through");
	await runner.kick();
	assert.equal(commands.filter(command => command.type === "PlaceBid").length, 1, "no further bid from either visitor");
	assert.equal(runner.statusOf(OLD_VISITOR).decision.reason, "PRICE_CANNOT_CARRY_FEE", "the refusal holds while the floor stays unfundable");
	assert.equal(runner.statusOf(VISITOR).decision.status, "RUNNING", "the other visitor's run is submitted and waits on its verdict");
});
