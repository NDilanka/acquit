// The scenario run store across a reopen of its database: a finished snapshot comes back as it was, a run
// that was RUNNING is marked FAILED with RESTARTED and its steps are not resumed, and the bounds hold in
// the table as they do in memory. A real chain run is the first case; the others commit synthetic runs.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { boundedRuns, startScenario } from "../src/scenarios.ts";
import type { RunBounds, ScenarioRun, ScenarioRuns, ScenarioStep } from "../src/scenarios.ts";
import { openDatabase } from "../src/store.ts";
import { drive, harness } from "./scenario-harness.ts";

async function tempDatabase(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "acquit-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return join(root, "runs.db");
}

function runOf(id: string, requesterId: string, state: ScenarioRun["state"], steps: readonly ScenarioStep[] = []): ScenarioRun {
	return { id, name: "verified-and-paid", requesterId, visitorId: `vis_${id}`, jobId: `job_${id}`, steps, state,
		endState: state === "DONE" ? { jobStatus: "PAID", reason: "CLIENT_APPROVAL" } : null, failure: null };
}

function commit(runs: ScenarioRuns, run: ScenarioRun): void {
	const admitted = runs.admit(run.requesterId);
	if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
	admitted.slot.commit(run);
}

function rowIds(path: string): string[] {
	const db = openDatabase(path);
	try {
		return db.prepare("SELECT id FROM scenario_runs ORDER BY rowid").all().map(row => String(row.id));
	} finally { db.close(); }
}

test("a finished run's snapshot survives a reopen of the database, unchanged", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "verified-and-paid");
		assert.equal(run.state, "DONE");
		const reopened = openDatabase(h.path);
		try {
			assert.deepEqual(boundedRuns(undefined, reopened).get(run.id), run);
		} finally { reopened.close(); }
	} finally { await h.dispose(); }
});

test("a run RUNNING when the store reopens is FAILED with RESTARTED, keeps its recorded steps, and resumes none", async t => {
	const path = await tempDatabase(t);
	const step: ScenarioStep = { name: "open-job", actor: "CLIENT", startedAt: "2026-10-06T12:00:00.000Z", endedAt: "2026-10-06T12:00:00.010Z",
		ms: 10, outcome: "opened job_scn_run_a", label: "Scripted agent (Simulated)" };
	const first = openDatabase(path);
	try {
		commit(boundedRuns(undefined, first), runOf("scn_run_a", "req-a", "RUNNING", [step]));
	} finally { first.close(); }

	const reopened = openDatabase(path);
	try {
		const recovered = boundedRuns(undefined, reopened).get("scn_run_a");
		assert.deepEqual(recovered, { ...runOf("scn_run_a", "req-a", "FAILED", [step]), failure: "RESTARTED" });
		const row = reopened.prepare("SELECT state FROM scenario_runs WHERE id = ?").get("scn_run_a");
		assert.equal(row?.state, "FAILED", "the row is rewritten, so the next reopen keeps the same answer");
	} finally { reopened.close(); }
	const again = openDatabase(path);
	try {
		assert.deepEqual(boundedRuns(undefined, again).get("scn_run_a"), { ...runOf("scn_run_a", "req-a", "FAILED", [step]), failure: "RESTARTED" });
	} finally { again.close(); }
});

test("the per-requester bound holds after a reopen: the oldest finished run is gone from the table too", async t => {
	const path = await tempDatabase(t);
	const bounds: RunBounds = { perRequester: 2, running: 5, total: 100 };
	const first = openDatabase(path);
	try {
		const runs = boundedRuns(bounds, first);
		for (let index = 0; index < 3; index++) commit(runs, runOf(`scn_a_${index}`, "req-a", "DONE"));
		assert.equal(runs.size(), 2);
	} finally { first.close(); }
	assert.deepEqual(rowIds(path), ["scn_a_1", "scn_a_2"]);

	const reopened = openDatabase(path);
	try {
		const runs = boundedRuns(bounds, reopened);
		assert.equal(runs.size(), 2);
		assert.equal(runs.get("scn_a_0"), undefined);
		assert.equal(runs.get("scn_a_2")?.state, "DONE");
	} finally { reopened.close(); }
});

test("the store-wide bound holds after a reopen: the oldest finished run goes across requesters, in the table too", async t => {
	const path = await tempDatabase(t);
	const bounds: RunBounds = { perRequester: 10, running: 5, total: 3 };
	const first = openDatabase(path);
	try {
		const runs = boundedRuns(bounds, first);
		commit(runs, runOf("scn_0", "req-a", "DONE"));
		commit(runs, runOf("scn_1", "req-b", "DONE"));
		commit(runs, runOf("scn_2", "req-a", "DONE"));
		commit(runs, runOf("scn_3", "req-b", "DONE"));
		assert.equal(runs.size(), 3);
	} finally { first.close(); }
	assert.deepEqual(rowIds(path), ["scn_1", "scn_2", "scn_3"]);

	const reopened = openDatabase(path);
	try {
		const runs = boundedRuns(bounds, reopened);
		assert.equal(runs.size(), 3);
		assert.equal(runs.get("scn_0"), undefined);
		assert.equal(runs.get("scn_3")?.requesterId, "req-b");
	} finally { reopened.close(); }
});

test("a credential in a failing step's error text is kept out of the stored snapshot and the polling body", async () => {
	const h = await harness();
	try {
		const leaked = ["token=sentinel-app-token-value", "Authorization: Bearer sentinel-bearer-value-0000",
			"https://x-access-token:sentinel-url-password@github.com/owner/repo.git"];
		const failingPush = { push: async () => { throw new Error(`git push failed: ${leaked.join(" ")}`); } };
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
		const started = await startScenario({ ...h.deps, workspace: failingPush }, "verified-and-paid", h.visitor, h.visitor.id, admitted.slot);
		const run = await started.finished;
		assert.equal(run.state, "FAILED");
		assert.equal(run.steps.at(-1)?.outcome, "FAILED STEP_FAILED");
		const polled = JSON.stringify(h.deps.runs.get(run.id));
		const stored = String(h.deps.store.db.prepare("SELECT snapshot FROM scenario_runs WHERE id = ?").get(run.id)?.snapshot);
		for (const secret of ["sentinel-app-token-value", "sentinel-bearer-value", "sentinel-url-password"]) {
			assert.equal(polled.includes(secret), false, `the polling body holds ${secret}`);
			assert.equal(stored.includes(secret), false, `the stored snapshot holds ${secret}`);
		}
	} finally { await h.dispose(); }
});

test("an interrupted write of a finished run leaves its snapshot and journal as they were, and a reopen stamps the cleanup", async t => {
	const path = await tempDatabase(t);
	const db = openDatabase(path);
	try {
		const runs = boundedRuns(undefined, db);
		const running = runOf("scn_run_c", "req-c", "RUNNING");
		commit(runs, running);
		// The journal's write is interrupted after the snapshot's, the way a stop between the two statements would leave them.
		db.exec("CREATE TRIGGER interrupt_journal BEFORE UPDATE ON scenario_cleanup BEGIN SELECT RAISE(ABORT, 'interrupted'); END;");
		assert.throws(() => runs.save({ ...running, state: "DONE", endState: { jobStatus: "PAID", reason: "CLIENT_APPROVAL" } }), /interrupted/);
		assert.equal(runs.get(running.id)?.state, "RUNNING", "memory keeps the committed state");
		db.exec("DROP TRIGGER interrupt_journal");
		assert.equal(db.prepare("SELECT state FROM scenario_runs WHERE id = ?").get(running.id)?.state, "RUNNING");
		assert.equal(db.prepare("SELECT finished_at FROM scenario_cleanup WHERE run_id = ?").get(running.id)?.finished_at, null);
	} finally { db.close(); }

	// The reopen finds the run RUNNING: it is FAILED with RESTARTED, and its journal is stamped so the cleanup can reach it.
	const reopened = openDatabase(path);
	try {
		assert.deepEqual(boundedRuns(undefined, reopened).get("scn_run_c"), { ...runOf("scn_run_c", "req-c", "FAILED"), failure: "RESTARTED" });
		assert.notEqual(reopened.prepare("SELECT finished_at FROM scenario_cleanup WHERE run_id = ?").get("scn_run_c")?.finished_at, null);
	} finally { reopened.close(); }
});

test("the identity columns and a finished state are write-once in SQL, whatever writes the row", async t => {
	const path = await tempDatabase(t);
	const db = openDatabase(path);
	try {
		commit(boundedRuns(undefined, db), runOf("scn_run_d", "req-d", "DONE"));
		assert.throws(() => db.prepare("UPDATE scenario_runs SET name = 'dispute-arbiter' WHERE id = ?").run("scn_run_d"), /write-once/);
		assert.throws(() => db.prepare("UPDATE scenario_runs SET job_id = 'job_other' WHERE id = ?").run("scn_run_d"), /write-once/);
		assert.throws(() => db.prepare("UPDATE scenario_cleanup SET job_id = 'job_other' WHERE run_id = ?").run("scn_run_d"), /write-once/);
		assert.throws(() => db.prepare("UPDATE scenario_runs SET state = 'RUNNING' WHERE id = ?").run("scn_run_d"), /cannot resume/);
		assert.deepEqual({ ...db.prepare("SELECT name, job_id, state FROM scenario_runs WHERE id = ?").get("scn_run_d") },
			{ name: "verified-and-paid", job_id: "job_scn_run_d", state: "DONE" });
	} finally { db.close(); }
});

test("an unfinished journal is stamped at a reopen only where the run's own receipt proves its job", async t => {
	const path = await tempDatabase(t);
	const first = openDatabase(path);
	try {
		commit(boundedRuns(undefined, first), runOf("scn_unproven", "req-u", "DONE"));
		first.prepare("UPDATE scenario_cleanup SET finished_at = NULL WHERE run_id = ?").run("scn_unproven");
	} finally { first.close(); }
	const reopened = openDatabase(path);
	try {
		boundedRuns(undefined, reopened);
		assert.equal(reopened.prepare("SELECT finished_at FROM scenario_cleanup WHERE run_id = ?").get("scn_unproven")?.finished_at, null);
	} finally { reopened.close(); }
});
