// The scenario cleanup, against the fake App: a finished run's fork and work repo go once the TTL has passed,
// a RUNNING run's fork is never touched, a fork with no finished run is swept too, and a removal the App
// refuses keeps its row for the next pass. The guard the App applies to each removal is tested against the
// real client in github.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { provisionDemoVisitor } from "../src/acquit.ts";
import { instant } from "../src/ids.ts";
import type { Instant } from "../src/ids.ts";
import { ScenarioRefused, startScenario } from "../src/scenarios.ts";
import { SCENARIO_SWEEP_TTL_MS, sweepScenarioRuns } from "../src/sweep.ts";
import type { ScenarioRepoDeleter } from "../src/sweep.ts";
import { newVisitorId, readVisitor, visitorRepositoryName } from "../src/visitors.ts";
import type { VisitorRow } from "../src/visitors.ts";
import { harness, start } from "./scenario-harness.ts";
import type { Harness } from "./scenario-harness.ts";
import { DEMO_REPOSITORY } from "./hidden-fixture.ts";

const nowInstant = (): Instant => instant(new Date().toISOString());
const after = (ms: number): Instant => instant(new Date(Date.now() + ms).toISOString());

/** A run visitor the way the scenario route provisions one: a fork of the source, counted under the requester. */
async function forkedVisitor(h: Harness, requester: VisitorRow): Promise<VisitorRow> {
	const id = newVisitorId();
	const provisioned = await provisionDemoVisitor(h.acquit, { id, ipKey: "scenario-cleanup", scenarioOf: requester.id,
		fork: async () => {
			const forked = await h.github.createClientRepo({ repository: DEMO_REPOSITORY, name: visitorRepositoryName(id) });
			return { kind: "FORKED", repository: forked.repository, id: forked.id };
		} });
	if (provisioned.kind !== "CREATED") throw new Error(`the run visitor was not created: ${provisioned.kind}`);
	return provisioned.visitor;
}

/** The TTL the sweep applies, past which a finished run's repositories are due. */
const PAST_TTL = SCENARIO_SWEEP_TTL_MS + 60_000;

test("a finished run's fork and work repo are removed once the TTL has passed, and kept before it", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "verified-and-paid", visitor)).finished;
		assert.equal(run.state, "DONE");
		assert.equal(h.github.clientRepos.size, 1);
		assert.equal(h.github.workRepos.size, 1);

		const db = h.deps.store.db;
		assert.deepEqual(await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: nowInstant() }), { swept: [], workRepos: [], kept: [] });
		assert.equal(h.github.clientRepos.size, 1);
		assert.equal(h.github.workRepos.size, 1);

		const report = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report.swept, [visitor.id]);
		assert.deepEqual(report.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.deepEqual(report.kept, []);
		assert.equal(h.github.clientRepos.size, 0);
		assert.equal(h.github.workRepos.size, 0);
		assert.equal(readVisitor(db, visitor.id)?.state, "SWEPT");
		assert.deepEqual(await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) }), { swept: [], workRepos: [], kept: [] });
	} finally { await h.dispose(); }
});

test("a RUNNING run's fork is kept by every pass, and it is swept once the run finishes", async () => {
	let open!: () => void;
	const gate = new Promise<void>(resolve => { open = resolve; });
	const h = await harness({ verdictGate: gate });
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const started = await start(h, "verified-and-paid", visitor);
		assert.equal(started.run.state, "RUNNING");
		const db = h.deps.store.db;
		assert.deepEqual(await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) }), { swept: [], workRepos: [], kept: [] });
		assert.equal(h.github.clientRepos.size, 1);

		open();
		assert.equal((await started.finished).state, "DONE");
		assert.deepEqual((await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) })).swept, [visitor.id]);
		assert.equal(h.github.clientRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a fork with no finished run, from a start the core refused or one never started, is swept once past the TTL", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const stranded = await forkedVisitor(h, h.visitor);
		const refused = await forkedVisitor(h, h.visitor);
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error("the first start must be admitted");
		await assert.rejects(startScenario({ ...h.deps, issueNumber: 999 }, "verified-and-paid", refused, h.visitor.id, admitted.slot),
			(error: unknown) => error instanceof ScenarioRefused && error.code === "NOT_FOUND");
		assert.equal(h.deps.runs.size(), 0);

		const report = await sweepScenarioRuns({ db: h.deps.store.db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual([...report.swept].sort(), [stranded.id, refused.id].sort());
		assert.equal(h.github.clientRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a removal the App refuses keeps its row, and the next pass retries exactly that work", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "verified-and-paid", visitor)).finished;
		assert.equal(run.state, "DONE");
		const db = h.deps.store.db;
		const mismatch = (): Promise<never> => Promise.reject(Object.assign(new Error("not ours"), { code: "GITHUB_FORK_MISMATCH" }));
		const refusing: ScenarioRepoDeleter = { deleteClientRepo: mismatch, deleteWorkRepo: mismatch };

		const first = await sweepScenarioRuns({ db, app: refusing, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(first.swept, []);
		assert.deepEqual(first.kept.map(item => ({ id: item.id, reason: item.reason })), [
			{ id: visitor.id, reason: "GITHUB_FORK_MISMATCH" },
			{ id: run.id, reason: "GITHUB_FORK_MISMATCH" },
		]);
		assert.notEqual(readVisitor(db, visitor.id)?.state, "SWEPT");
		assert.equal(h.github.clientRepos.size, 1);
		assert.equal(h.github.workRepos.size, 1);

		const second = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(second.swept, [visitor.id]);
		assert.deepEqual(second.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.deepEqual(second.kept, []);
	} finally { await h.dispose(); }
});

test("the API runs the scenario sweep on its own timer every ten minutes, through the function the tests above cover", () => {
	const server = readFileSync(new URL("../../../apps/api/src/server.ts", import.meta.url), "utf8");
	assert.match(server, /setInterval\(\(\) => \{\s*void sweepScenarioRuns\(/);
	assert.match(server, /\}, 10 \* 60_000\);/);
});
