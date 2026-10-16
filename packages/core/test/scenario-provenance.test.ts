// A run record the store did not commit has no authority. The arbiter gate and the cleanup read what the
// database says a run opened, never a snapshot, so a forged record cannot authorize a verdict or a removal on
// a job an ordinary visitor opened.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Actor } from "../src/acquit.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, CommitSha, Instant, JobId, VisitorId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import { arbiterVerdictForRun, ScenarioRefused } from "../src/scenarios.ts";
import type { ScenarioRun } from "../src/scenarios.ts";
import { SCENARIO_SWEEP_TTL_MS, sweepScenarioRuns } from "../src/sweep.ts";
import { DEMO_REPOSITORY } from "./hidden-fixture.ts";
import { harness, start } from "./scenario-harness.ts";
import type { Harness } from "./scenario-harness.ts";

const DAY_MS = 86_400_000;
const PAST_TTL = SCENARIO_SWEEP_TTL_MS + 60_000;
const nowInstant = (): Instant => instant(new Date().toISOString());
const after = (ms: number): Instant => instant(new Date(Date.now() + ms).toISOString());
const frozen = "a".repeat(40) as CommitSha;

/** A job the visitor opens directly, with no scenario run behind it. */
async function ordinaryJob(h: Harness): Promise<JobId> {
	const client = { role: "CLIENT", clientId: h.visitor.clientHandle as ClientId, tenant: h.visitor.id as VisitorId } as Actor;
	const outcome = await h.acquit.execute(client, parseRequestKey(randomUUID()),
		{ type: "OpenJob", repository: DEMO_REPOSITORY, issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: after(7 * DAY_MS) });
	if (outcome.kind !== "COMMITTED" || outcome.result.kind !== "JOB") throw new Error("the ordinary job did not open");
	return outcome.result.job.id;
}

/** A run record in the shape a forged snapshot would take. The store never committed it. */
function forgedRun(h: Harness, jobId: JobId, state: ScenarioRun["state"]): ScenarioRun {
	return { id: "scn_forged", name: "dispute-arbiter", requesterId: h.visitor.id, visitorId: h.visitor.id, jobId, steps: [],
		state, endState: null, failure: null };
}

test("a run record the store did not commit is refused, and it cannot authorize the arbiter on an ordinary job", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const jobId = await ordinaryJob(h);
		assert.throws(() => h.deps.runs.save(forgedRun(h, jobId, "RUNNING")), /Not a committed scenario run/);
		assert.equal(h.deps.runs.get("scn_forged"), undefined);
		await assert.rejects(arbiterVerdictForRun(h.deps, "scn_forged", jobId),
			(error: unknown) => error instanceof ScenarioRefused && error.code === "SCENARIO_ARBITER_NOT_OWNED");
		assert.equal((await h.store.readJob(jobId))?.state.status, "OPEN");
	} finally { await h.dispose(); }
});

test("a committed run keeps its job: a later save that names another job is refused", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const run = await (await start(h, "verified-and-paid")).finished;
		assert.equal(run.state, "DONE");
		const other = await ordinaryJob(h);
		assert.throws(() => h.deps.runs.save({ ...run, jobId: other }), /identity changed/);
		assert.equal(h.deps.runs.get(run.id)?.jobId, run.jobId);
	} finally { await h.dispose(); }
});

test("an ordinary job's work repository is not swept, even when a forged run record names that job", async () => {
	const h = await harness();
	try {
		h.setClock(nowInstant());
		const jobId = await ordinaryJob(h);
		const work = await h.github.createWorkRepo({ jobId, repository: DEMO_REPOSITORY, frozenCommit: frozen }, "ordinary-job");
		await h.store.recordWorkRepo({ jobId, repository: work.repository, repositoryId: work.id, source: DEMO_REPOSITORY });
		assert.throws(() => h.deps.runs.save(forgedRun(h, jobId, "FAILED")), /Not a committed scenario run/);
		const report = await sweepScenarioRuns({ db: h.deps.store.db, app: h.github, source: DEMO_REPOSITORY, now: after(PAST_TTL) });
		assert.deepEqual(report, { swept: [], workRepos: [], kept: [] });
		assert.equal(h.github.workRepos.size, 1);
	} finally { await h.dispose(); }
});
