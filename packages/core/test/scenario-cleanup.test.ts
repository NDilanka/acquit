// The scenario cleanup, against the fake App: a finished run's fork and work repo go once the TTL has passed,
// a RUNNING run's fork is never touched, a fork with no finished run is swept too, and a removal the App
// refuses keeps its row for the next pass. The guard the App applies to each removal is tested against the
// real client in github.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { provisionDemoVisitor } from "../src/acquit.ts";
import { createFakeGitHubApp, GitHubAppError } from "../src/github.ts";
import type { FakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { Instant, JobId } from "../src/ids.ts";
import { boundedRuns, ScenarioRefused, startScenario } from "../src/scenarios.ts";
import type { StartedScenario } from "../src/scenarios.ts";
import { openDatabase } from "../src/store.ts";
import { keptSummary, SCENARIO_SWEEP_TTL_MS, sweepExpiredVisitors, sweepScenarioRuns } from "../src/sweep.ts";
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

test("ten completed runs and a capped eleventh: all ten work repositories are removed once past the TTL", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		for (let index = 0; index < 10; index++) {
			const visitor = await forkedVisitor(h, h.visitor);
			assert.equal((await (await start(h, "verified-and-paid", visitor)).finished).state, "DONE");
		}
		assert.equal(h.github.workRepos.size, 10);
		// The route admits a start before it provisions the visitor. Admission drops the oldest finished snapshot
		// first, and then the requester's day cap refuses the visitor. The cleanup must still reach that run.
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
		const capped = await provisionDemoVisitor(h.acquit, { id: newVisitorId(), ipKey: "scenario-cleanup", scenarioOf: h.visitor.id,
			fork: async () => ({ kind: "NO_APP" }) });
		assert.equal(capped.kind === "CAPPED" ? capped.reason : null, "CAP_SCENARIOS_REQUESTER_DAY");
		admitted.slot.release();
		assert.equal(h.deps.runs.size(), 9);

		const report = await sweepScenarioRuns({ db: h.deps.store.db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.equal(report.workRepos.filter(work => work.outcome === "DELETED").length, 10);
		assert.deepEqual(report.kept, []);
		assert.equal(h.github.workRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a work repository whose ref write fails after the fork is recorded at the fork, and the cleanup removes it", async () => {
	const github = createFakeGitHubApp();
	// The App makes the fork, then the ref write does not answer. The fork is real, so its identity must be recorded.
	const failsAfterFork: FakeGitHubApp = { ...github, createWorkRepo: async (request, requestId, onFork) => {
		await github.createWorkRepo(request, requestId, onFork);
		throw new GitHubAppError("GITHUB_NETWORK", "the ref write did not answer");
	} };
	const h = await harness({ github: failsAfterFork });
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "deadline-refund", visitor)).finished;
		assert.equal(run.state, "DONE");
		assert.equal(github.workRepos.size, 1);
		const report = await sweepScenarioRuns({ db: h.deps.store.db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.equal(github.workRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a work repository record written after an earlier pass saw none reopens the job's cleanup", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "deadline-refund", visitor)).finished;
		assert.equal(run.state, "DONE");
		const [work] = [...h.github.workRepos.values()];
		const db = h.deps.store.db;
		// An earlier pass saw no record for the job, as it would before the creation's record landed.
		db.prepare("DELETE FROM work_repos WHERE job_id = ?").run(run.jobId);
		const earlier = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(earlier.workRepos, []);
		assert.equal(h.github.workRepos.size, 1);
		// The late record names the repository, and the next pass removes it. Its source is the fork the job was made from.
		await h.store.recordWorkRepo({ jobId: run.jobId as JobId, repository: work.repository, repositoryId: work.id, source: visitor.repository ?? DEMO_REPOSITORY });
		const late = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(late.kept, []);
		assert.deepEqual(late.workRepos.map(item => ({ runId: item.runId, outcome: item.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.equal(h.github.workRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a work repository whose creation is still pending keeps its job, and nothing is marked swept", async () => {
	const github = createFakeGitHubApp();
	// The fork never answers, so the creation stays a retryable outbox row and the job has no record.
	const unanswered: FakeGitHubApp = { ...github, createWorkRepo: async () => { throw new GitHubAppError("GITHUB_NETWORK", "the fork did not answer"); } };
	const h = await harness({ github: unanswered });
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "deadline-refund", visitor)).finished;
		assert.equal(run.state, "DONE");
		assert.equal(github.workRepos.size, 0);
		const report = await sweepScenarioRuns({ db: h.deps.store.db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report.swept, [visitor.id]);
		assert.deepEqual(report.kept, [{ id: run.id, repository: "", reason: "WORK_REPO_PENDING" }]);
		assert.deepEqual(report.workRepos, []);
		assert.equal(h.deps.store.db.prepare("SELECT work_swept_at FROM scenario_cleanup WHERE run_id = ?").get(run.id)?.work_swept_at, null);
	} finally { await h.dispose(); }
});

test("the expiry sweep the CLI runs first leaves a RUNNING or fresh finished scenario's fork, even after a forward clock jump", async () => {
	let open!: () => void;
	const gate = new Promise<void>(resolve => { open = resolve; });
	const h = await harness({ verdictGate: gate });
	let started: StartedScenario | null = null;
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		started = await start(h, "verified-and-paid", visitor);
		assert.equal(started.run.state, "RUNNING");
		const db = h.deps.store.db;
		// A clock two days ahead expires every visitor. The expiry pass sweeps the harness's own requester, which has no
		// fork, and leaves the RUNNING run's visitor and its fork alone.
		const jump = after(2 * 86_400_000);
		assert.deepEqual(await sweepExpiredVisitors({ db, app: h.github, source: DEMO_REPOSITORY, now: jump }), { swept: [h.visitor.id], repositories: [], kept: [] });
		assert.equal(h.github.clientRepos.size, 1);
		assert.notEqual(readVisitor(db, visitor.id)?.state, "SWEPT");

		open();
		assert.equal((await started.finished).state, "DONE");
		// Fresh and finished: the expiry pass with the jumped clock still leaves it, and only the scenario TTL removes it.
		assert.deepEqual(await sweepExpiredVisitors({ db, app: h.github, source: DEMO_REPOSITORY, now: jump }), { swept: [], repositories: [], kept: [] });
		assert.deepEqual(await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: nowInstant() }), { swept: [], workRepos: [], kept: [] });
		assert.equal(h.github.clientRepos.size, 1);
		assert.equal(h.github.workRepos.size, 1);
	} finally {
		// The run is released and awaited before the database closes, so a failure above is the one reported.
		open();
		await started?.finished;
		await h.dispose();
	}
});

test("a work repository recorded while the job's removal is in flight is not marked swept by that removal", async () => {
	const github = createFakeGitHubApp();
	let refFails = true;
	// The fork is made and recorded, then the ref write fails until the test lets it land: the creation stays retryable.
	const failsUntilReleased: FakeGitHubApp = { ...github, createWorkRepo: async (request, requestId, onFork) => {
		const created = await github.createWorkRepo(request, requestId, onFork);
		if (refFails) throw new GitHubAppError("GITHUB_NETWORK", "the ref write did not answer");
		return created;
	} };
	// The removal takes effect at GitHub, and its answer is held until the test lets it go.
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	let tookEffect!: () => void;
	const removing = new Promise<void>(resolve => { tookEffect = resolve; });
	const deferred: FakeGitHubApp = { ...failsUntilReleased, deleteWorkRepo: async request => {
		const outcome = await github.deleteWorkRepo(request);
		tookEffect();
		await held;
		return outcome;
	} };
	const h = await harness({ github: deferred });
	let sweeping: ReturnType<typeof sweepScenarioRuns> | null = null;
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "deadline-refund", visitor)).finished;
		assert.equal(run.state, "DONE");
		const db = h.deps.store.db;
		const original = [...github.workRepos.values()][0];
		assert.ok(original);
		assert.equal(db.prepare("SELECT repository_id FROM work_repos WHERE job_id = ?").get(run.jobId)?.repository_id, original.id);

		sweeping = sweepScenarioRuns({ db, app: deferred, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		await removing;
		// The removal has taken effect and its answer is held. The creation's retry now finds no repository at the name
		// it recorded, so it creates a replacement and records it. The deadline-refund chain moved the job's clock two
		// days, and the job's own retry times move with it.
		refFails = false;
		h.setClock(after(3 * 86_400_000));
		await h.acquit.tick();
		const replacement = [...github.workRepos.values()][0];
		assert.equal(github.workRepos.size, 1);
		assert.notEqual(replacement?.id, original.id);
		assert.equal(db.prepare("SELECT repository_id FROM work_repos WHERE job_id = ?").get(run.jobId)?.repository_id, replacement?.id);
		release();

		const first = await sweeping;
		assert.deepEqual(first.kept.map(item => ({ id: item.id, reason: item.reason })), [{ id: run.id, reason: "WORK_REPO_CHANGED" }]);
		assert.equal(db.prepare("SELECT work_swept_at FROM scenario_cleanup WHERE run_id = ?").get(run.id)?.work_swept_at, null);
		const second = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(second.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.equal(github.workRepos.size, 0);
	} finally {
		// The held removal is released and awaited before the database closes, so the failure above is the one reported.
		release();
		await sweeping?.catch(() => undefined);
		await h.dispose();
	}
});

test("a finished run whose journal was left unfinished is stamped at the reopen, and its work repository is then removed", async t => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "verified-and-paid", visitor)).finished;
		assert.equal(run.state, "DONE");
		const db = h.deps.store.db;
		// The state an interrupted write left behind: the snapshot reads DONE and the journal never finished.
		db.prepare("UPDATE scenario_cleanup SET finished_at = NULL WHERE run_id = ?").run(run.id);
		const reopened = openDatabase(h.path);
		try {
			boundedRuns(undefined, reopened);
			assert.notEqual(reopened.prepare("SELECT finished_at FROM scenario_cleanup WHERE run_id = ?").get(run.id)?.finished_at, null);
		} finally { reopened.close(); }
		const report = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.equal(h.github.workRepos.size, 0);
	} finally { await h.dispose(); }
});

test("a work repository whose visitor fork was removed first is swept, and its row is marked swept", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const visitor = await forkedVisitor(h, h.visitor);
		const run = await (await start(h, "verified-and-paid", visitor)).finished;
		assert.equal(run.state, "DONE");
		const fork = visitor.repository;
		if (fork === null) throw new Error("the run visitor has no fork");
		// The visitor's fork is removed before the sweep reaches the work repo, as an earlier pass would leave it.
		assert.equal(await h.github.deleteClientRepo({ repository: fork, source: DEMO_REPOSITORY, id: visitor.repositoryId }), "DELETED");
		assert.equal(h.github.clientRepos.size, 0);
		assert.equal(h.github.workRepos.size, 1);

		const db = h.deps.store.db;
		const report = await sweepScenarioRuns({ db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report.swept, [visitor.id]);
		assert.deepEqual(report.workRepos.map(work => ({ runId: work.runId, outcome: work.outcome })), [{ runId: run.id, outcome: "DELETED" }]);
		assert.deepEqual(report.kept, []);
		assert.equal(h.github.workRepos.size, 0);
		assert.notEqual(db.prepare("SELECT work_swept_at FROM scenario_cleanup WHERE run_id = ?").get(run.id)?.work_swept_at, null);
	} finally { await h.dispose(); }
});

test("the kept log names each kept repository with the reason that kept it", () => {
	assert.equal(keptSummary([
		{ repository: "acquit-forks/demo-abc123", reason: "GITHUB_FORK_MISMATCH" },
		{ repository: "", reason: "WORK_REPO_PENDING" },
	]), "acquit-forks/demo-abc123 (GITHUB_FORK_MISMATCH), no repository recorded (WORK_REPO_PENDING)");
	const backlog = Array.from({ length: 10_000 }, (_, i) => ({ repository: `acquit-forks/demo-${String(i).padStart(12, "0")}-job_${i}`,
		reason: i % 3 === 0 ? "WORK_REPO_PENDING" : "GITHUB_FORK_MISMATCH" }));
	const line = keptSummary(backlog);
	assert.ok(line.length < 1_000, `a 10,000-row backlog logs ${line.length} characters`);
	assert.ok(line.startsWith("acquit-forks/demo-000000000000-job_0 (WORK_REPO_PENDING), acquit-forks/demo-000000000001-job_1 (GITHUB_FORK_MISMATCH)"));
	assert.ok(line.endsWith(", and 9990 more; all kept by reason: GITHUB_FORK_MISMATCH 6666, WORK_REPO_PENDING 3334"), line);
});

test("the API runs the scenario sweep on its own timer every ten minutes, through the function the tests above cover", () => {
	const server = readFileSync(new URL("../../../apps/api/src/server.ts", import.meta.url), "utf8");
	assert.match(server, /setInterval\(\(\) => \{\s*void sweepScenarioRuns\(/);
	assert.match(server, /\}, 10 \* 60_000\);/);
	assert.match(server, /kept \$\{report\.kept\.length\} repositories for the next pass: \$\{keptSummary\(report\.kept\)\}/);
});
