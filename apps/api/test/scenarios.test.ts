// The scenario routes' server side, driven with the core's in-process harness: the scripted verifier, the
// fake PayPal, and the fake GitHub app. POST starts a run on a visitor of its own and GET polls it, and the
// visibility, fixture, admission, cap, and workspace rules are the route's own. No network, no child process,
// no GitHub or PayPal call.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertTimings, harness, start } from "../../../packages/core/test/scenario-harness.ts";
import type { Harness } from "../../../packages/core/test/scenario-harness.ts";
import { demoFixture, demoProtectedPaths, DEMO_FROZEN_AT, DEMO_REPOSITORY, exampleContract } from "../../../packages/core/test/hidden-fixture.ts";
import { provisionDemoVisitor } from "../../../packages/core/src/acquit.ts";
import type { DemoVisitorResult } from "../../../packages/core/src/acquit.ts";
import type { CommitSha, JobId } from "../../../packages/core/src/ids.ts";
import type { ScenarioRun, ScenarioRuns } from "../../../packages/core/src/scenarios.ts";
import { frozenTests } from "../../../packages/core/src/score-card-trees.ts";
import { newVisitorId, visitorRepositoryName } from "../../../packages/core/src/visitors.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import type { HouseWorkPort } from "../../../packages/house/src/runner.ts";
import { scenarioFixtureOf, scenarioReply, scenarioRoutingFor, scriptedWorkspace } from "../src/scenarios.ts";
import type { ScenarioComposition, ScenarioRouting } from "../src/scenarios.ts";

const FIXTURE = { repository: DEMO_REPOSITORY, issueNumber: 12 };
const OTHER_REPOSITORY = "other-client/invoice-app";
const OTHER_FROZEN_AT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as CommitSha;

function routingOf(h: Harness, overrides: Partial<ScenarioComposition> = {}): ScenarioRouting {
	return scenarioRoutingFor({ acquit: h.acquit, store: h.deps.store, workspace: h.deps.workspace, runs: h.deps.runs, now: h.deps.now,
		fixture: FIXTURE, fixtures: [demoFixture()], forkSource: DEMO_REPOSITORY, provision: h.provision,
		...overrides });
}

/** Provisions a run visitor whose fork the App made under the demo fork prefix, so its job opens on that fork. */
function forkingProvision(h: Harness): (requester: VisitorRow) => Promise<DemoVisitorResult> {
	return async requester => {
		const id = newVisitorId();
		return provisionDemoVisitor(h.acquit, { id, ipKey: "scenario-fork-test", scenarioOf: requester.id,
			fork: async () => ({ kind: "FORKED", repository: `acquit-forks/${visitorRepositoryName(id)}`, id: null }) });
	};
}

/** GET one run through the route until it stops running. */
async function settle(routing: ScenarioRouting, visitor: VisitorRow, id: string): Promise<ScenarioRun> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const reply = await scenarioReply(routing, visitor, "GET", id);
		assert.equal(reply.status, 200);
		const run = reply.body as ScenarioRun;
		if (run.state !== "RUNNING") return run;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`run ${id} did not stop`);
}

/** Holds every running slot of a requester, so the next start meets the running limit. */
function holdSlots(runs: ScenarioRuns, requesterId: string, count: number): void {
	for (let index = 0; index < count; index++) {
		const admitted = runs.admit(requesterId);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
	}
}

test("an unknown scenario name is refused as UNKNOWN_SCENARIO", async () => {
	const h = await harness();
	try {
		assert.deepEqual(await scenarioReply(routingOf(h), h.visitor, "POST", "submit-everything"), { status: 404, body: { error: "UNKNOWN_SCENARIO" } });
	} finally { await h.dispose(); }
});

test("POST starts verified-and-paid on a visitor of its own, and GET polls the run to DONE, PAID on CLIENT_APPROVAL", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "verified-and-paid");
		assert.equal(posted.status, 201);
		const { scenarioId, jobId } = posted.body as { scenarioId: string; jobId: string };
		assert.match(scenarioId, /^scn_/);
		assert.match(jobId, /^job_/);
		const run = await settle(routing, h.visitor, scenarioId);
		assert.equal(run.state, "DONE");
		assert.equal(run.jobId, jobId);
		assert.equal(run.requesterId, h.visitor.id);
		assert.notEqual(run.visitorId, h.visitor.id);
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "approve"]);
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("POST starts deadline-refund and GET polls the run to DONE, REFUNDED on DELIVERY_DEADLINE", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "deadline-refund");
		assert.equal(posted.status, 201);
		const { scenarioId } = posted.body as { scenarioId: string };
		const run = await settle(routing, h.visitor, scenarioId);
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.endState, { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" });
		assert.equal(run.steps.find(step => step.name === "advance-clock")?.label, "Simulated time for this job");
	} finally { await h.dispose(); }
});

test("another visitor's run is refused as NOT_FOUND, the same answer an unknown run id gets", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "deadline-refund");
		const { scenarioId } = posted.body as { scenarioId: string };
		await settle(routing, h.visitor, scenarioId);
		const stranger: VisitorRow = { ...h.visitor, id: newVisitorId() };
		assert.deepEqual(await scenarioReply(routing, stranger, "GET", scenarioId), { status: 404, body: { error: "NOT_FOUND" } });
		assert.deepEqual(await scenarioReply(routing, stranger, "GET", "scn_nobody-holds-this"), { status: 404, body: { error: "NOT_FOUND" } });
		assert.equal((await scenarioReply(routing, h.visitor, "GET", scenarioId)).status, 200);
	} finally { await h.dispose(); }
});

test("dispute-arbiter starts with development off, and its verdict is the scenario's own, not a dev route", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "dispute-arbiter");
		assert.equal(posted.status, 201);
		const run = await settle(routing, h.visitor, (posted.body as { scenarioId: string }).scenarioId);
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "ARBITER_UPHELD" });
		assert.equal(run.steps.find(step => step.name === "arbiter-verdict")?.label, "Scripted agent (Simulated)");
	} finally { await h.dispose(); }
});

test("a deployment without the scenario fixture answers SCENARIO_FIXTURE_MISSING and provisions nothing", async () => {
	const h = await harness();
	try {
		let provisions = 0;
		const routing = routingOf(h, { fixture: null, provision: async requester => { provisions++; return h.provision(requester); } });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"),
			{ status: 503, body: { error: "SCENARIO_FIXTURE_MISSING", detail: "The deployment does not carry the fixture the judge scenarios open on." } });
		assert.equal(provisions, 0);
		assert.equal(h.deps.runs.size(), 0);
	} finally { await h.dispose(); }
});

test("the scenario fixture is the registry entry its key names, and nothing else", () => {
	const fixtures = [demoFixture()];
	assert.deepEqual(scenarioFixtureOf(fixtures, `${DEMO_REPOSITORY}#12`), FIXTURE);
	assert.equal(scenarioFixtureOf(fixtures, `${DEMO_REPOSITORY}#13`), null);
	assert.equal(scenarioFixtureOf([], `${DEMO_REPOSITORY}#12`), null);
});

test("a scenario fixture off the repository the App forks is refused before a visitor is provisioned", async () => {
	const other = demoFixture(exampleContract, { repository: OTHER_REPOSITORY, frozenAt: OTHER_FROZEN_AT, demoForkPrefix: "other-forks/" });
	const h = await harness({ fixtures: [demoFixture(), other] });
	try {
		let provisions = 0;
		const forking = forkingProvision(h);
		const routing = routingOf(h, { fixture: { repository: OTHER_REPOSITORY, issueNumber: 12 }, fixtures: [demoFixture(), other],
			provision: async requester => { provisions++; return forking(requester); } });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"),
			{ status: 503, body: { error: "SCENARIO_FIXTURE_MISMATCH", detail: "The scenario fixture is not on the repository the App forks visitors from." } });
		assert.equal(provisions, 0);
		assert.equal(h.deps.runs.size(), 0);
	} finally { await h.dispose(); }
});

test("a fork that another registered fixture's demo prefix names is refused, and retains no run", async () => {
	const unprefixed = demoFixture(exampleContract, { demoForkPrefix: undefined });
	const named = demoFixture(exampleContract, { repository: OTHER_REPOSITORY, frozenAt: OTHER_FROZEN_AT });
	const h = await harness({ fixtures: [unprefixed, named] });
	try {
		let provisions = 0;
		const forking = forkingProvision(h);
		const routing = routingOf(h, { fixtures: [unprefixed, named], provision: async requester => { provisions++; return forking(requester); } });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"),
			{ status: 503, body: { error: "SCENARIO_FIXTURE_MISMATCH", detail: "A visitor's fork opens on another registered fixture than the scenario's." } });
		assert.equal(provisions, 1);
		assert.equal(h.deps.runs.size(), 0);
		assert.equal(h.deps.runs.admit(h.visitor.id).kind, "ADMITTED", "the refused start releases its place");
	} finally { await h.dispose(); }
});

test("a fork of the scenario's repository freezes the scenario fixture beside another repository that shares its issue", async () => {
	const other = demoFixture(exampleContract, { repository: OTHER_REPOSITORY, frozenAt: OTHER_FROZEN_AT, demoForkPrefix: "other-forks/" });
	const h = await harness({ fixtures: [demoFixture(), other] });
	try {
		const routing = routingOf(h, { fixtures: [demoFixture(), other], provision: forkingProvision(h) });
		const posted = await scenarioReply(routing, h.visitor, "POST", "verified-and-paid");
		assert.equal(posted.status, 201);
		const { scenarioId, jobId } = posted.body as { scenarioId: string; jobId: string };
		const definition = (await h.store.readJob(jobId as JobId))?.contract?.definitionOfDone;
		assert.match(definition?.issue.repository ?? "", /^acquit-forks\/demo-/);
		assert.equal(definition?.frozenAt, DEMO_FROZEN_AT);
		assert.deepEqual(definition?.protectedPaths, demoProtectedPaths);
		assert.equal(definition?.hiddenManifest, exampleContract.digest);
		assert.equal((await settle(routing, h.visitor, scenarioId)).state, "DONE");
	} finally { await h.dispose(); }
});

test("a start the core refuses retains no run, and answers the core's own denial", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h, { fixture: { repository: DEMO_REPOSITORY, issueNumber: 999 } });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"), { status: 409, body: { error: "NOT_FOUND" } });
		assert.equal(h.deps.runs.size(), 0);
		assert.equal(h.deps.runs.admit(h.visitor.id).kind, "ADMITTED");
	} finally { await h.dispose(); }
});

test("a start refused by the scenario cap retains no run and answers the cap's own code", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h, { provision: async () => ({ kind: "CAPPED", reason: "CAP_SCENARIOS_DAY" }) });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"), { status: 429, body: { error: "CAP_SCENARIOS_DAY" } });
		assert.equal(h.deps.runs.size(), 0);
		assert.equal(h.deps.runs.admit(h.visitor.id).kind, "ADMITTED");
	} finally { await h.dispose(); }
});

test("a full visitor day refuses no scenario start: the start is admitted and the run completes", async () => {
	const h = await harness();
	try {
		// Fill the deployment's visitor day with 50 visitor reservations, the way the rows the day counts are written.
		for (let index = 0; index < 50; index++) h.deps.store.db.prepare("INSERT INTO cap_reservations VALUES ('VISITOR', ?, ?, 0, ?)")
			.run(`ip-${index}`, `v_full_${index}`, "2026-10-06T11:00:00.000Z");
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "verified-and-paid");
		assert.equal(posted.status, 201);
		const run = await settle(routing, h.visitor, (posted.body as { scenarioId: string }).scenarioId);
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
	} finally { await h.dispose(); }
});

test("a sixth start while five of a requester's runs are in flight is refused before a visitor is provisioned", async () => {
	const h = await harness();
	try {
		holdSlots(h.deps.runs, h.visitor.id, 5);
		let provisions = 0;
		const routing = routingOf(h, { provision: async requester => { provisions++; return h.provision(requester); } });
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"), { status: 429, body: { error: "SCENARIO_RUNNING_LIMIT" } });
		assert.equal(provisions, 0);
	} finally { await h.dispose(); }
});

test("the public wiring reaches HELD through card funding with the fake PayPal, and completes S1 with development off", async () => {
	const h = await harness({ publicFunding: true, waitMs: 5_000 });
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "verified-and-paid");
		assert.equal(posted.status, 201);
		const { scenarioId, jobId } = posted.body as { scenarioId: string; jobId: string };
		const run = await settle(routing, h.visitor, scenarioId);
		const funding = run.steps.find(step => step.name === "accept-and-fund");
		assert.equal(funding?.outcome, "HELD");
		assert.equal(funding?.label, "PayPal sandbox");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
		const chosen = h.deps.store.db.prepare("SELECT mode FROM job_funding WHERE job_id = ?").get(jobId) as { mode?: unknown } | undefined;
		assert.equal(chosen?.mode, "card");
	} finally { await h.dispose(); }
});

/** A frozen checkout the way the House prepares one: the fixture's own package, its own suite, and the buggy formatter. */
async function frozenCheckout(root: string, name: string, suite: string): Promise<string> {
	const workDir = join(root, name);
	await mkdir(join(workDir, "tests"), { recursive: true });
	await mkdir(join(workDir, "src"), { recursive: true });
	await writeFile(join(workDir, "README.md"), "invoice-app\n");
	await writeFile(join(workDir, "package.json"), `{"name":"invoice-app","private":true,"type":"module","description":"the fixture's own"}\n`);
	await writeFile(join(workDir, "tests/totals.test.ts"), suite);
	await writeFile(join(workDir, "src/money.ts"), "export const base = true;\n");
	return workDir;
}

test("the scripted push keeps the frozen package and suite, and writes only the entry's own files", async () => {
	const h = await harness();
	const root = await mkdtemp(join(tmpdir(), "acquit-scripted-"));
	try {
		const started = await start(h, "deadline-refund");
		await started.finished;
		const jobId = started.run.jobId as JobId;
		let checkouts = 0;
		const work: HouseWorkPort = {
			prepare: async () => ({ workDir: await frozenCheckout(root, `checkout-${checkouts++}`, frozenTests()) }),
			finalize: async () => ({ commit: "a".repeat(40) as CommitSha, files: [], patch: "" }),
			remove: () => {},
		};
		const workspace = scriptedWorkspace({ work, readJob: id => h.store.readJob(id) });

		assert.equal(await workspace.push(jobId, "honest-reference-table"), "a".repeat(40));
		const honest = join(root, "checkout-0");
		assert.match(await readFile(join(honest, "src/money.ts"), "utf8"), /MINOR_UNITS/);
		assert.equal(await readFile(join(honest, "package.json"), "utf8"), `{"name":"invoice-app","private":true,"type":"module","description":"the fixture's own"}\n`);
		assert.equal(await readFile(join(honest, "tests/totals.test.ts"), "utf8"), frozenTests());
		assert.equal(await readFile(join(honest, "README.md"), "utf8"), "invoice-app\n");

		await workspace.push(jobId, "cheat-hardcode-visible-values");
		const hardcoded = join(root, "checkout-1");
		assert.match(await readFile(join(hardcoded, "src/money.ts"), "utf8"), /const visible = new Map/);
		assert.equal(await readFile(join(hardcoded, "package.json"), "utf8"), `{"name":"invoice-app","private":true,"type":"module","description":"the fixture's own"}\n`);
		assert.equal(await readFile(join(hardcoded, "tests/totals.test.ts"), "utf8"), frozenTests());

		await workspace.push(jobId, "cheat-edit-frozen-test");
		assert.match(await readFile(join(root, "checkout-2", "tests/totals.test.ts"), "utf8"), /toBe\('1\.2'\)/);
	} finally {
		await h.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("a fixture whose visible rows differ from the score card's is refused before any file is written", async () => {
	const h = await harness();
	const root = await mkdtemp(join(tmpdir(), "acquit-scripted-"));
	try {
		const started = await start(h, "deadline-refund");
		await started.finished;
		const jobId = started.run.jobId as JobId;
		const drifted = frozenTests().replace("toBe('1.25')", "toBe('1.26')");
		const work: HouseWorkPort = {
			prepare: async () => ({ workDir: await frozenCheckout(root, "drifted", drifted) }),
			finalize: async () => { throw new Error("nothing is finalized for an incompatible fixture"); },
			remove: () => {},
		};
		const workspace = scriptedWorkspace({ work, readJob: id => h.store.readJob(id) });
		await assert.rejects(workspace.push(jobId, "honest-reference-table"), /^Error: SCENARIO_FIXTURE_INCOMPATIBLE/);
		assert.equal(await readFile(join(root, "drifted", "src/money.ts"), "utf8"), "export const base = true;\n");
	} finally {
		await h.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("a frozen suite whose test names differ but whose rows match the score card's is accepted by the scripted push", async () => {
	const h = await harness();
	const root = await mkdtemp(join(tmpdir(), "acquit-scripted-"));
	try {
		const started = await start(h, "deadline-refund");
		await started.finished;
		const jobId = started.run.jobId as JobId;
		const renamed = frozenTests().replace(/it\('case (\d+)'/g, "it('invoice row $1'");
		const work: HouseWorkPort = {
			prepare: async () => ({ workDir: await frozenCheckout(root, "renamed", renamed) }),
			finalize: async () => ({ commit: "a".repeat(40) as CommitSha, files: [], patch: "" }),
			remove: () => {},
		};
		const workspace = scriptedWorkspace({ work, readJob: id => h.store.readJob(id) });
		assert.equal(await workspace.push(jobId, "honest-reference-table"), "a".repeat(40));
	} finally {
		await h.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("an extra frozen test the score card does not generate is refused before any file is written", async () => {
	const h = await harness();
	const root = await mkdtemp(join(tmpdir(), "acquit-scripted-"));
	try {
		const started = await start(h, "deadline-refund");
		await started.finished;
		const jobId = started.run.jobId as JobId;
		const extra = `${frozenTests()}it('additional row', () => { expect(formatTotal([{ amount: 1 }], 'USD')).toBe('1.00'); });\n`;
		const work: HouseWorkPort = {
			prepare: async () => ({ workDir: await frozenCheckout(root, "extra", extra) }),
			finalize: async () => { throw new Error("nothing is finalized for an incompatible fixture"); },
			remove: () => {},
		};
		const workspace = scriptedWorkspace({ work, readJob: id => h.store.readJob(id) });
		await assert.rejects(workspace.push(jobId, "honest-reference-table"), /^Error: SCENARIO_FIXTURE_INCOMPATIBLE/);
		assert.equal(await readFile(join(root, "extra", "src/money.ts"), "utf8"), "export const base = true;\n");
	} finally {
		await h.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
