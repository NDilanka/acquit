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
import { demoFixture, jpyFixture } from "../../../packages/core/test/hidden-fixture.ts";
import type { ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import { stepKey } from "../../../packages/core/src/scenario-binding.ts";
import { SAMPLE_RUNS_PER_DAY, SAMPLE_VERIFIER_RETRIES, type SampleOrders } from "../../../packages/core/src/sample-runner.ts";
import { activityJson, activityLimit, ACTIVITY_LABELS } from "../src/sample-activity.ts";
import { createSampleRunner, sampleRunJobIds, type SampleFixtureRule, type SampleRunnerPorts, type SampleRunnerVisitor } from "../src/sample-runner.ts";

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
	const patch = (fields: Record<string, unknown>) => {
		rows = rows.map(row => (row.id === JOB_ID ? ({ ...row, ...fields } as unknown as JobRow) : row));
	};
	const runsStarted = () => (jobRow().state as { readonly attempts: { readonly runsStarted: number } }).attempts.runsStarted;

	const execute = async (actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome> => {
		actors.push(actor);
		commands.push(command);
		sent.push({ command, key });
		if (command.type === "PlaceBid") {
			const bid = { id: `bid_${commands.length}`, operator: OPERATOR, agent: command.agent, price: command.price,
				eta: command.eta, pitch: command.pitch, placedAt: now(), status: "PENDING" };
			patch({ bids: [bid] });
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
		log: (line: string) => { logs.push(line); },
		/** The House client accepts the bid and funds the job. */
		houseAccepts: () => patch({ bids: jobRow().bids.map(bid => ({ ...bid, status: "ACCEPTED" })), state: heldState(now()) }),
		/** The verifier run ends with no verdict, as a publish or deadline failure does: the attempt is READY again, nothing is judged. */
		verifierRunFails: () => patch({ state: heldState(now(), "READY", runsStarted()) }),
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
		jobs: world.rows,
		agentsOf: handle => (handle === OPERATOR ? [AGENT] : []),
		ordersOf: () => ORDERS,
		fixtureRule: FIXTURE_RULE,
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
	assert.equal(runner.statusOf(VISITOR, world.rows()).decision.status, "IDLE", "no matching starter is an idle visitor, not a refusal");
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
	const paused = runner.statusOf(VISITOR, world.rows());
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
	assert.equal(runner.statusOf(VISITOR, world.rows()).decision.status, "IDLE");
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
